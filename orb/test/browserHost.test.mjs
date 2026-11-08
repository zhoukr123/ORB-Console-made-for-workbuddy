/* browserHost.cjs 单测：纯 Node（node:test + assert/strict + createRequire 加载 CJS），
 * 不 require('electron')、不发网络、不碰真实桥、零 npm 依赖。
 *
 * 关于 decodeFrames 对「非对象 JSON」的约定（见 browserHost.cjs 注释）：
 *   Native Messaging 帧按协议一律是 JSON 对象，因此 decodeFrames 只把「非 null、
 *   非数组的对象」放进 frames；数组 / null / 数字 / 字符串 / 布尔一律丢弃。
 * 关于 encodeFrame 对不可序列化对象的约定：
 *   返回空 Buffer 作为安全 no-op（向 stdout 写 0 字节不产生协议帧），绝不抛异常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODULE_PATH = require.resolve('../desktop/browserHost.cjs');

/* 在唯一的 require 点前后采样 stdin 的 data 监听器数量，用于证明「被 require 时
 * 不会自动启动宿主循环」——宿主循环会 process.stdin.on('data', ...) 并起定时器，
 * 一旦发生，下面这个数量会变化，且整个 node --test 进程将不会自然退出。 */
const listenersBefore = process.stdin.listenerCount('data');
const m = require(MODULE_PATH);
const listenersAfter = process.stdin.listenerCount('data');

/* 构造一条「声明长度 = payload.length」的原始帧；declaredLen 可覆盖以制造畸形帧。 */
function rawFrame(payloadBuf, declaredLen = payloadBuf.length) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(declaredLen >>> 0, 0);
  return Buffer.concat([header, payloadBuf]);
}

test('导出签名：encodeFrame / decodeFrames 为函数，MAX_FRAME / startHost 存在', () => {
  assert.equal(typeof m.encodeFrame, 'function');
  assert.equal(typeof m.decodeFrames, 'function');
  assert.equal(m.MAX_FRAME, 1024 * 1024);
  assert.equal(typeof m.startHost, 'function');
});

test('require 模块无副作用：不自动启动宿主循环（--test 能正常退出即证明）', () => {
  // 若模块在 require 时启动了 startHost，会给 stdin 挂 data 监听并起定时器，
  // 这个数量会变化；更重要的是 node --test 进程会被常驻句柄拖住而无法结束。
  assert.equal(listenersAfter, listenersBefore, 'require 不应修改 stdin 的 data 监听器');
  const again = require(MODULE_PATH); // 命中缓存，同样不应有副作用
  assert.strictEqual(again, m, '重复 require 应返回同一模块实例');
  assert.equal(process.stdin.listenerCount('data'), listenersBefore);
});

test('单帧往返：encodeFrame → decodeFrames 还原对象，rest 为空、skip 为 0', () => {
  const obj = { type: 'provider_hello', protocol: 1, nested: { x: [1, 2, 3] }, 中文: '值', ok: true };
  const frame = m.encodeFrame(obj);
  assert.ok(Buffer.isBuffer(frame));
  assert.equal(frame.readUInt32LE(0), frame.length - 4, '长度前缀 = payload 字节数');
  const r = m.decodeFrames(frame);
  assert.deepEqual(r.frames, [obj]);
  assert.equal(r.rest.length, 0);
  assert.equal(r.skip, 0);
});

test('长度前缀为 4 字节小端 uint32（含 > 255 的多字节长度）', () => {
  const big = { s: 'x'.repeat(300) };
  const frame = m.encodeFrame(big);
  const len = frame.length - 4;
  assert.ok(len > 255);
  assert.equal(frame[0], len & 0xff);
  assert.equal(frame[1], (len >>> 8) & 0xff);
  assert.equal(frame[2], (len >>> 16) & 0xff);
  assert.equal(frame[3], (len >>> 24) & 0xff);
  assert.deepEqual(m.decodeFrames(frame).frames, [big]);
});

test('粘包多帧：一个 buffer 内多条完整帧全部解出', () => {
  const objs = [{ a: 1 }, { b: 2 }, { c: [3, 4] }];
  const buf = Buffer.concat(objs.map(m.encodeFrame));
  const r = m.decodeFrames(buf);
  assert.deepEqual(r.frames, objs);
  assert.equal(r.rest.length, 0);
  assert.equal(r.skip, 0);
});

test('半包保留 rest：先解出完整帧，残缺帧留在 rest，补齐后再解出', () => {
  const f1 = m.encodeFrame({ n: 1 });
  const f2 = m.encodeFrame({ n: 2, data: 'x'.repeat(50) });
  const all = Buffer.concat([f1, f2]);
  const cut = f1.length + 4 + 10; // 保留 f2 的头部 + 10 字节 payload
  const partial = all.subarray(0, cut);
  const r1 = m.decodeFrames(partial);
  assert.deepEqual(r1.frames, [{ n: 1 }]);
  assert.ok(r1.rest.length > 0, '半包应保留在 rest');
  assert.equal(r1.skip, 0);
  const r2 = m.decodeFrames(Buffer.concat([r1.rest, all.subarray(cut)]));
  assert.deepEqual(r2.frames, [{ n: 2, data: 'x'.repeat(50) }]);
  assert.equal(r2.rest.length, 0);
});

test('超长帧（> 1MB）被丢弃且不抛，后续有效帧仍能解出', () => {
  const oversize = rawFrame(Buffer.alloc(m.MAX_FRAME + 1, 0x61));
  const valid = m.encodeFrame({ after: true });
  const buf = Buffer.concat([oversize, valid]);
  let r;
  assert.doesNotThrow(() => { r = m.decodeFrames(buf); });
  assert.deepEqual(r.frames, [{ after: true }], '超长帧不得进入 frames');
  assert.equal(r.rest.length, 0);
  assert.equal(r.skip, 0, '完整超长帧已整帧丢弃');
});

test('超长帧只收到部分：frames 为空、rest 为空、skip > 0（交给后续 chunk 继续丢弃）', () => {
  const headerOnly = Buffer.alloc(4);
  headerOnly.writeUInt32LE(m.MAX_FRAME + 100, 0); // 声明 1MB+100，但 payload 只有 10 字节
  const buf = Buffer.concat([headerOnly, Buffer.alloc(10, 0x62)]);
  let r;
  assert.doesNotThrow(() => { r = m.decodeFrames(buf); });
  assert.deepEqual(r.frames, []);
  assert.equal(r.rest.length, 0);
  assert.ok(r.skip > 0, '应返回还需丢弃的字节数');
});

test('非法 JSON 帧被丢弃且不抛，后续有效帧仍能解出', () => {
  const bad = rawFrame(Buffer.from('{ not json ]'));
  const valid = m.encodeFrame({ hello: 'world' });
  let r;
  assert.doesNotThrow(() => { r = m.decodeFrames(Buffer.concat([bad, valid])); });
  assert.deepEqual(r.frames, [{ hello: 'world' }]);
  assert.equal(r.rest.length, 0);
});

test('非对象 JSON（数组 / null / 数字 / 字符串 / 布尔）被丢弃，仅保留对象帧', () => {
  const values = ['[1,2,3]', 'null', '42', '"str"', 'true'];
  let buf = Buffer.alloc(0);
  for (const s of values) buf = Buffer.concat([buf, rawFrame(Buffer.from(s))]);
  buf = Buffer.concat([buf, m.encodeFrame({ keep: true })]);
  const r = m.decodeFrames(buf);
  assert.deepEqual(r.frames, [{ keep: true }]);
});

test('encodeFrame 对不可序列化对象不抛（返回空 Buffer 作为安全 no-op）', () => {
  const circular = {}; circular.self = circular;
  const boom = { toJSON() { throw new Error('boom'); } };
  const cases = [
    circular,                 // 循环引用
    { n: 1n },                // BigInt
    boom,                     // toJSON 抛错
    undefined,
    () => {},
    Symbol('x'),
  ];
  for (const c of cases) {
    let out;
    assert.doesNotThrow(() => { out = m.encodeFrame(c); }, '不可序列化输入不得抛异常');
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.length, 0, '不可序列化应返回空 Buffer，不写任何协议字节');
  }
  // 可序列化的非对象（数组 / 字符串 / null / 数字）仍能正常编码成帧
  for (const v of [[1, 2], 'hi', null, 7]) {
    const f = m.encodeFrame(v);
    assert.ok(f.length > 4);
    assert.equal(f.readUInt32LE(0), f.length - 4);
  }
});

test('decodeFrames 空 Buffer / 残缺头部：返回空 frames，不抛', () => {
  for (const b of [Buffer.alloc(0), Buffer.from([1, 2, 3])]) {
    let r;
    assert.doesNotThrow(() => { r = m.decodeFrames(b); });
    assert.deepEqual(r.frames, []);
    assert.equal(r.rest.length, b.length, '不足一帧的字节原样留在 rest');
  }
});

test('decodeFrames 绝不抛异常：非 Buffer 输入也安全返回空结果', () => {
  for (const bad of [undefined, null, 42, 'str', {}, []]) {
    let r;
    assert.doesNotThrow(() => { r = m.decodeFrames(bad); });
    assert.ok(Array.isArray(r.frames));
    assert.ok(Buffer.isBuffer(r.rest));
    assert.equal(r.frames.length, 0);
    assert.equal(r.rest.length, 0);
  }
});
