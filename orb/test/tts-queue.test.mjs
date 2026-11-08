/* 播报队列的调度行为单测。
 *
 * 为什么用「从 panel.html 抽源码」这种别扭方式：
 *   面板是单文件内联脚本，没有模块边界，直接 import 不了。
 *   而这两条规则恰恰最容易写错、又最难在真机上复现（要靠"晚上启动"才撞上）：
 *     ① 两句寒暄前后脚到 → 前一句必须**完整念完**，不能被后一句掐断；
 *     ② 用户操作触发的回应 → 必须立刻压过正在念的寒暄。
 *   与其靠人肉点击验证，不如把调度器那段源码原样取出来，用桩跑几个交叠场景。
 *   抽取边界的标记一旦被改动会**明确报错**，不会静默退化成"测了个空"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PANEL = path.join(import.meta.dirname, "..", "desktop", "panel.html");
const src = fs.readFileSync(PANEL, "utf8");

const START = "const TTS_PRIO_INTERACTIVE = 0;";
const END = "/** 浏览器内置语音（Web Speech）";
const from = src.indexOf(START);
const to = src.indexOf(END);
assert.ok(from > 0, "找不到播报队列起始标记 " + START);
assert.ok(to > from, "找不到播报队列结束标记 " + END);
const SCHEDULER = src.slice(from, to);

const PRELUDE = `
let ttsGen = 0;
let ttsAudio = null;
/* 调度器抽取区间（TTS_PRIO_INTERACTIVE → 浏览器内置语音）不含 voiceStopAll 的定义，
   它在 panel.html 更靠前的位置。真实面板里它负责掐掉 liveAudio，
   这里音频层全是桩，补一个空实现让 ttsKillSound 可跑；不改调度语义。 */
function voiceStopAll(keep) { if (!keep) ttsAudio = null; }
function charNum0(v, lo, hi, def) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
function ttsSpeak(text, opt) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (!charCfg.tts.enabled) return false;
  const o = opt || {};
  if (charCfg.persona === 'off' && !o.force) return false;
  const prio = charNum0(o.prio, 0, 9, TTS_PRIO_NORMAL);
  return ttsEnqueue({ text: s, o, prio, at: Date.now() });
}
function ttsStop() { ttsGen++; ttsQueue.length = 0; ttsPlaying = null; ttsAudio = null; }
`;

/** 造一个受控环境：音频层全用桩，每条"播放"100ms 后自动结束。 */
function makeEnv() {
  const log = [];
  const charCfg = { persona: "gentle", tts: { enabled: true, offline: true, gen: true } };
  const fakeWindow = { ORB_VOICEPACK: { personas: { gentle: {} } } };
  const ttsOfflineSpeak = (s, o, gen, onFinish) => {
    log.push("play:" + s);
    setTimeout(() => { log.push("finish:" + s); if (onFinish) onFinish(); }, 100);
    return true;
  };
  const factory = new Function(
    "charCfg", "window", "ttsOfflineSpeak", "ttsOnlineSpeak", "ttsBrowserSpeak",
    "orbClipFor", "ttsGenOn", "ttsOnlineOn",
    PRELUDE + SCHEDULER +
    "\nreturn { speak: ttsSpeak, stop: ttsStop, q: () => ttsQueue, playing: () => ttsPlaying };",
  );
  const api = factory(
    charCfg, fakeWindow, ttsOfflineSpeak,
    () => { throw new Error("本测不该走在线合成"); },
    () => { throw new Error("本测不该走系统语音"); },
    () => "x.opus", () => true, () => false,
  );
  return { api, log };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("两句寒暄前后脚到：第一句完整念完，第二句接在后面（不再出现半句）", async () => {
  const { api, log } = makeEnv();
  /* 复刻 speakStart：欢迎（寒暄）与夜间提醒（寒暄）几乎同时进入 */
  api.speak("欢迎回来", { prio: 2 });
  api.speak("这个点还没睡呀", { prio: 2 });
  await sleep(60);
  assert.deepEqual(log, ["play:欢迎回来"], "第二句不该在此时出声");
  assert.equal(api.q().length, 1, "第二句应在队列里等着");
  await sleep(300);
  assert.deepEqual(log, [
    "play:欢迎回来", "finish:欢迎回来",
    "play:这个点还没睡呀", "finish:这个点还没睡呀",
  ], "两句必须串行，且第一句有完整的结束事件");
});

test("用户操作触发的回应会压过正在念的寒暄（不迟钝）", async () => {
  const { api, log } = makeEnv();
  api.speak("欢迎回来", { prio: 2 });
  await sleep(20);
  api.speak("声音已开启", { prio: 0 });
  await sleep(20);
  assert.deepEqual(log, ["play:欢迎回来", "play:声音已开启"], "高优先级应立即接上");
  assert.equal(api.playing().text, "声音已开启");
  await sleep(220);
  assert.equal(api.q().length, 0);
});

test("同一句不重复念（队列内去重）", async () => {
  const { api, log } = makeEnv();
  api.speak("欢迎回来", { prio: 2 });
  api.speak("早点休息", { prio: 2 });
  api.speak("早点休息", { prio: 2 });
  await sleep(320);
  assert.equal(log.filter((x) => x.startsWith("play:")).length, 2, "重复的那句应被丢掉");
});

test("队列有上限，不会无限堆积", async () => {
  const { api } = makeEnv();
  api.speak("第一句", { prio: 1 });
  for (let i = 0; i < 8; i++) api.speak("排队" + i, { prio: 2 });
  assert.ok(api.q().length <= 3, "队列长度应被截到上限，实际 " + api.q().length);
});

test("关声音会连队列一起清空（不会关了还冒两句）", async () => {
  const { api } = makeEnv();
  api.speak("第一句", { prio: 1 });
  api.speak("第二句", { prio: 2 });
  api.stop();
  assert.equal(api.q().length, 0);
  assert.equal(api.playing(), null);
});
