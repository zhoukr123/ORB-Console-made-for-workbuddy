/* pluginHost 单测：注册契约 / 生命周期 / 正则流水线安全边界 / 二维码结构断言。
 * 二维码部分只做「结构 + 已知常量」断言（格式信息 BCH 值、版本信息 BCH 值、
 * 定位/时序/对齐几何、确定性），没有做真机扫码；这一点在交付说明里如实标注。 */
import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PLUGINS, createPluginHost } from "../pluginHost.mjs";

const plugin = (id) => BUILTIN_PLUGINS.find((p) => p.id === id);
const regexRun = (args) => plugin("regex-pipeline").run(args);
const qrRun = (args) => plugin("qr-encode").run(args);

/** 从矩阵左上角读出 15 bit 格式信息（第一副本） */
function readFormatBits(m) {
  let v = 0;
  const set = (i, dark) => {
    if (dark) v |= 1 << i;
  };
  for (let i = 0; i <= 5; i++) set(i, m[i][8]);
  set(6, m[7][8]);
  set(7, m[8][8]);
  set(8, m[8][7]);
  for (let i = 9; i < 15; i++) set(i, m[8][14 - i]);
  return v;
}

/** 从右上角读出 18 bit 版本信息（仅 v>=7 存在） */
function readVersionBits(m, size) {
  let v = 0;
  for (let i = 0; i < 18; i++) {
    if (m[Math.floor(i / 3)][size - 11 + (i % 3)]) v |= 1 << i;
  }
  return v;
}

/* ---------------- register ---------------- */

test("register 拒绝非法 id（大写/下划线/超长/空）", () => {
  const h = createPluginHost();
  const bad = ["Bad", "has_underscore", "", "a".repeat(33), "-lead", "中文"];
  for (const id of bad) {
    const r = h.register({ id, level: "S", run() {} });
    assert.equal(r.ok, false, `应拒绝 id: ${id}`);
    assert.equal(r.error, "bad-id");
  }
});

test("register 拒绝 level 不是 S/A", () => {
  const h = createPluginHost();
  for (const level of ["B", "s", "", undefined, 1]) {
    const r = h.register({ id: "x1", level, run() {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, "bad-level");
  }
});

test("register 拒绝缺 run 或 run 不是函数", () => {
  const h = createPluginHost();
  assert.equal(h.register({ id: "x1", level: "S" }).error, "bad-run");
  assert.equal(h.register({ id: "x1", level: "S", run: 1 }).error, "bad-run");
});

test("register 拒绝 id 重复（含与内置同名）", () => {
  const h = createPluginHost();
  const def = { id: "x1", level: "A", run: () => ({ ok: true }) };
  assert.equal(h.register(def).ok, true);
  assert.equal(h.register(def).error, "duplicate-id");
  assert.equal(h.register({ id: "qr-encode", level: "S", run() {} }).error, "duplicate-id");
});

test("register 成功只回 { id, name, level }，缺 name 时回落到 id", () => {
  const h = createPluginHost();
  const r = h.register({ id: "x1", level: "A", run: () => ({ ok: true }) });
  assert.deepEqual(r, { ok: true, plugin: { id: "x1", name: "x1", level: "A" } });
});

/* ---------------- unregister ---------------- */

test("unregister 能注销自定义插件，重复注销返回 removed:false", () => {
  const h = createPluginHost();
  h.register({ id: "x1", level: "S", run: () => ({ ok: true }) });
  assert.deepEqual(h.unregister("x1"), { ok: true, removed: true });
  assert.deepEqual(h.unregister("x1"), { ok: true, removed: false });
});

test("unregister 拒绝注销内置插件", () => {
  const h = createPluginHost();
  const r = h.unregister("regex-pipeline");
  assert.equal(r.ok, false);
  assert.equal(r.error, "builtin");
  assert.equal(h.list().plugins.length, 2);
});

/* ---------------- list ---------------- */

test("list 含两个内置插件且 builtin:true", () => {
  const h = createPluginHost();
  const r = h.list();
  assert.equal(r.ok, true);
  assert.equal(r.plugins.length, 2);
  for (const p of r.plugins) {
    assert.equal(p.builtin, true);
    assert.equal(p.level, "S");
    assert.ok(Array.isArray(p.inputs) && Array.isArray(p.outputs));
    assert.equal(typeof p.brief, "string");
  }
  assert.deepEqual(r.plugins.map((p) => p.id), ["regex-pipeline", "qr-encode"]);
});

test("list 返回的是快照，外部改动不污染注册表", () => {
  const h = createPluginHost();
  const first = h.list();
  first.plugins[0].inputs.push("污染");
  first.plugins.pop();
  assert.equal(h.list().plugins.length, 2);
  assert.ok(!h.list().plugins[0].inputs.includes("污染"));
});

/* ---------------- run ---------------- */

test("run 未知 id 返回 unknown-plugin", () => {
  const h = createPluginHost();
  assert.deepEqual(h.run("nope"), { ok: false, error: "unknown-plugin" });
});

test("run 成功时包一层 { ok, pluginId, ms, result }", () => {
  const h = createPluginHost({ now: () => 1000 });
  const r = h.run("regex-pipeline", { text: "abc", rules: [] });
  assert.equal(r.ok, true);
  assert.equal(r.pluginId, "regex-pipeline");
  assert.equal(r.ms, 0);
  assert.equal(r.result.text, "abc");
});

test("run 把插件抛出的异常抓成 ok:false", () => {
  const h = createPluginHost();
  h.register({ id: "boom", level: "S", run: () => { throw new Error("炸了"); } });
  const r = h.run("boom", {});
  assert.equal(r.ok, false);
  assert.equal(r.pluginId, "boom");
  assert.equal(r.error, "炸了");
});

test("run 把插件返回的 ok:false 透成失败", () => {
  const h = createPluginHost();
  h.register({ id: "no", level: "A", run: () => ({ ok: false, error: "nope" }) });
  assert.deepEqual(h.run("no", {}), { ok: false, pluginId: "no", error: "nope" });
});

/* ---------------- run：异步插件（MCP 网关一类） ---------------- */

test("run 异步插件：await 后拿到同一套 { ok, pluginId, ms, result }", async () => {
  const h = createPluginHost({ now: () => 2000 });
  h.register({ id: "async-tool", level: "A", run: async () => ({ ok: true, value: 42 }) });
  const r = await h.run("async-tool", {});
  assert.equal(r.ok, true);
  assert.equal(r.pluginId, "async-tool");
  assert.equal(r.ms, 0);
  assert.equal(r.result.value, 42);
});

test("run 异步插件 reject 也收成 ok:false，不炸到调用方", async () => {
  const h = createPluginHost();
  h.register({ id: "async-boom", level: "A", run: async () => { throw new Error("异步炸了"); } });
  const r = await h.run("async-boom", {});
  assert.deepEqual(r, { ok: false, pluginId: "async-boom", error: "异步炸了" });
});

test("run 同步插件仍同步返回对象（老调用方不用改）", () => {
  const h = createPluginHost();
  h.register({ id: "sync-tool", level: "S", run: () => ({ ok: true }) });
  const r = h.run("sync-tool", {});
  assert.equal(typeof r.then, "undefined");
  assert.equal(r.ok, true);
});

test("list 带上 fidelity：内置按 executable，自定义按登记时盖的值", () => {
  const h = createPluginHost();
  h.register({ id: "decl", level: "A", fidelity: "declarative", run: () => ({ ok: true }) });
  const byId = Object.fromEntries(h.list().plugins.map((p) => [p.id, p]));
  assert.equal(byId["regex-pipeline"].fidelity, "executable");
  assert.equal(byId["decl"].fidelity, "declarative");
});

/* ---------------- regex-pipeline ---------------- */

test("regex 单条替换", () => {
  const r = regexRun({ text: "a-b-c", rules: [{ pattern: "-", flags: "g", replace: "_" }] });
  assert.equal(r.ok, true);
  assert.equal(r.text, "a_b_c");
  assert.deepEqual(r.hits, [2]);
  assert.equal(r.applied, 1);
  assert.deepEqual(r.errors, []);
});

test("regex 多条按顺序依次替换（后一条吃前一条的结果）", () => {
  const r = regexRun({
    text: "aaa",
    rules: [
      { pattern: "a", flags: "g", replace: "b" },
      { pattern: "b", flags: "g", replace: "c" },
    ],
  });
  assert.equal(r.text, "ccc");
  assert.deepEqual(r.hits, [3, 3]);
  assert.equal(r.applied, 2);
});

test("regex 单条编译失败只跳过该条，errors 有记录", () => {
  const r = regexRun({
    text: "abc",
    rules: [
      { pattern: "(", flags: "g", replace: "x" },
      { pattern: "b", flags: "g", replace: "c" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, "acc");
  assert.deepEqual(r.hits, [0, 1]);
  assert.equal(r.applied, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].index, 0);
  assert.equal(r.errors[0].error, "bad-pattern");
});

test("regex 超长输入被拒（too-large）", () => {
  const r = regexRun({ text: "x".repeat(20), rules: [], limit: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "too-large");
});

test("regex text 缺失被拒（text-required）", () => {
  assert.equal(regexRun({ rules: [] }).error, "text-required");
});

test("regex 规则数超过 50 条整体拒绝", () => {
  const rules = Array.from({ length: 51 }, () => ({ pattern: "a", flags: "g", replace: "b" }));
  const r = regexRun({ text: "a", rules });
  assert.equal(r.ok, false);
  assert.equal(r.error, "too-many-rules");
  // 恰好 50 条应放行
  assert.equal(regexRun({ text: "a", rules: rules.slice(0, 50) }).ok, true);
});

test("regex 非法 flags 被剔除（不抛异常，仍按 g 替换）", () => {
  const r = regexRun({ text: "aaa", rules: [{ pattern: "a", flags: "gX$y", replace: "b" }] });
  assert.equal(r.ok, true);
  assert.equal(r.text, "bbb");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.hits, [3]);
});

test("regex pattern 超长被跳过并记录 pattern-too-long", () => {
  const r = regexRun({ text: "a", rules: [{ pattern: "a".repeat(501), flags: "g", replace: "" }] });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 0);
  assert.equal(r.errors[0].error, "pattern-too-long");
});

/* ---------------- qr-encode ---------------- */

test("qr version 1：HELLO WORLD 走通，size = 17 + 4*version", () => {
  const r = qrRun({ text: "HELLO WORLD" });
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  assert.equal(r.ec, "M");
  assert.equal(r.mask, 0);
  assert.equal(r.size, 21);
  assert.equal(r.modules.length, 21);
  assert.equal(r.modules[0].length, 21);
});

test("qr size 公式对所有可达版本成立", () => {
  for (const [n, ec] of [[11, "M"], [30, "M"], [60, "M"], [90, "M"], [120, "M"]]) {
    const r = qrRun({ text: "A".repeat(n), ec });
    assert.equal(r.ok, true, `长度 ${n} 应能编码`);
    assert.equal(r.size, 21 + (r.version - 1) * 4);
    assert.equal(r.size, 17 + r.version * 4);
  }
});

test("qr 三个定位图形几何正确", () => {
  const r = qrRun({ text: "HELLO WORLD" });
  const m = r.modules;
  const s = r.size;
  for (const [cr, cc] of [[3, 3], [3, s - 4], [s - 4, 3]]) {
    assert.equal(m[cr][cc], true, `中心 (${cr},${cc}) 应为深色`);
    // 7x7 外圈四角与四边中点为深色，内圈一圈为浅色
    for (const [dr, dc] of [[-3, -3], [-3, 0], [-3, 3], [0, -3], [0, 3], [3, -3], [3, 3]]) {
      assert.equal(m[cr + dr][cc + dc], true, `外圈 (${cr + dr},${cc + dc}) 应为深色`);
    }
    // 浅色环在偏移 ±2，中心 3x3 仍是深色
    assert.equal(m[cr - 2][cc - 2], false, "浅色环应为浅色");
    assert.equal(m[cr - 2][cc], false, "浅色环应为浅色");
    assert.equal(m[cr - 1][cc - 1], true, "中心 3x3 应为深色");
  }
  // 左上定位图形的分隔符（第 7 行/列）必须是浅色
  assert.equal(m[7][0], false);
  assert.equal(m[0][7], false);
  assert.equal(m[7][7], false);
});

test("qr 时序图形黑白交替（第 6 行 / 第 6 列）", () => {
  const r = qrRun({ text: "HELLO WORLD" }); // v1 无对齐图形，时序图形是完整的
  const m = r.modules;
  const s = r.size;
  for (let i = 8; i <= s - 9; i++) {
    assert.equal(m[6][i], i % 2 === 0, `行时序 col=${i}`);
    assert.equal(m[i][6], i % 2 === 0, `列时序 row=${i}`);
  }
});

test("qr 对齐图形（v2）中心深、内圈浅、外环深", () => {
  const r = qrRun({ text: "HELLO WORLD 1234" }); // 16 字节 → v2
  assert.equal(r.version, 2);
  const m = r.modules;
  assert.equal(m[18][18], true, "中心应为深色");
  assert.equal(m[17][17], false, "内圈应为浅色");
  assert.equal(m[16][16], true, "外环应为深色");
});

test("qr 同一输入两次调用结果完全一致（确定性）", () => {
  const a = qrRun({ text: "确定性 测试 12345", ec: "Q" });
  const b = qrRun({ text: "确定性 测试 12345", ec: "Q" });
  assert.deepEqual(a.modules, b.modules);
  assert.equal(a.ascii, b.ascii);
  assert.equal(a.svg, b.svg);
  assert.equal(a.mask, 0);
});

test("qr 格式信息是标准常量 0x5412（EC=M, mask=0）", () => {
  const r = qrRun({ text: "HELLO WORLD", ec: "M" });
  assert.equal(readFormatBits(r.modules), 0x5412);
});

test("qr 版本信息是标准常量 0x07C94（v7）", () => {
  const r = qrRun({ text: "A".repeat(110), ec: "M" });
  assert.equal(r.version, 7);
  assert.equal(readVersionBits(r.modules, r.size), 0x07c94);
});

test("qr 超长文本返回 too-long，不静默截断", () => {
  const r = qrRun({ text: "A".repeat(400) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "too-long");
  assert.equal(r.modules, undefined);
});

test("qr svg 以 <svg 开头、用 currentColor、不含写死的 #000", () => {
  const r = qrRun({ text: "HELLO WORLD" });
  assert.ok(r.svg.startsWith("<svg"));
  assert.ok(r.svg.includes("currentColor"));
  assert.ok(!r.svg.includes("#000"));
  assert.ok(!r.svg.includes("<?xml"));
  assert.ok(r.svg.includes('viewBox="0 0 29 29"'));
  assert.equal((r.svg.match(/<path/g) || []).length, 1);
  assert.ok(r.svg.trimEnd().endsWith("</svg>"));
});

test("qr ascii 保留静默区，宽度是模块数的两倍", () => {
  const r = qrRun({ text: "HELLO WORLD" });
  const lines = r.ascii.split("\n");
  assert.equal(lines.length, 21 + 8);
  assert.equal(lines[0].length, (21 + 8) * 2);
  assert.ok(lines[0].trim() === "", "首行应是静默区");
});

test("qr 空字符串也能出码，且默认 EC 为 M", () => {
  const r = qrRun({ text: "" });
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  assert.equal(r.ec, "M");
});

/* ---------------- qr 数学自查 ---------------- */

/** v1 的功能模块判定：三个 9 格角 + 第 6 行/列，仅用于测试里反向读取 */
function v1IsFunc(r, c, s) {
  return (r <= 8 && c <= 8) || (r <= 8 && c >= s - 8) || (r >= s - 8 && c <= 8) || r === 6 || c === 6;
}

/** 反向读出 v1 的全部码字（去 mask 0、按蛇形顺序取位） */
function v1ReadCodewords(m) {
  const s = m.length;
  const bits = [];
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < s; vert++) {
      const row = upward ? s - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (v1IsFunc(row, col, s)) continue;
        let dark = m[row][col];
        if ((row + col) % 2 === 0) dark = !dark; // 去掩码
        bits.push(dark ? 1 : 0);
      }
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  return cw;
}

function gfMul(a, b) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

test("qr v1 码字与手算结果一致（模式/计数/终止符/补齐）", () => {
  const r = qrRun({ text: "HELLO WORLD", ec: "M" });
  const cw = v1ReadCodewords(r.modules);
  assert.equal(cw.length, 26, "v1 共 26 个码字");
  assert.deepEqual(cw.slice(0, 16), [
    0x40, 0xb4, 0x84, 0x54, 0xc4, 0xc4, 0xf2, 0x05,
    0x74, 0xf5, 0x24, 0xc4, 0x40, 0xec, 0x11, 0xec,
  ]);
});

test("qr Reed-Solomon 校验子全为零（纠错码数学正确）", () => {
  const r = qrRun({ text: "HELLO WORLD", ec: "M" });
  const cw = v1ReadCodewords(r.modules); // v1 单块，天然就是数据+纠错顺序
  let x = 1; // α^0
  for (let i = 0; i < 10; i++) {
    // 把整段码字当多项式求值，10 个根上都必须为 0，否则纠错码一定算错
    let y = 0;
    for (const c of cw) y = gfMul(y, x) ^ c;
    assert.equal(y, 0, `第 ${i} 个根处校验子应为 0`);
    x = gfMul(x, 0x02);
  }
});

/* ---------------- stats ---------------- */

test("stats 计数：runs / failed / byId / lastAt", () => {
  let t = 5000;
  const h = createPluginHost({ now: () => t });
  assert.deepEqual(h.stats(), { ok: true, count: 2, runs: 0, failed: 0, byId: {}, lastAt: null });

  h.register({ id: "boom", level: "S", run: () => { throw new Error("x"); } });
  h.run("regex-pipeline", { text: "a", rules: [] });
  t = 5100;
  h.run("regex-pipeline", { text: "a", rules: [] });
  h.run("boom", {});

  const s = h.stats();
  assert.equal(s.count, 3);
  assert.equal(s.runs, 3);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.byId, { "regex-pipeline": 2, boom: 1 });
  assert.equal(s.lastAt, 5100);
});
