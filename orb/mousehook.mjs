/* ══════════ 全局鼠标钩子 ══════════
 * 目的：录制工作流时，把「你手动在别的软件里做的操作」也录下来。
 *
 * 为什么挂在 bridge（Node 进程）而不是 Electron 主进程：
 *   Node 22 下 uiohook-napi 已实测可加载并可捕获真实事件；Electron 主进程的 ABI
 *   未必匹配。而录制状态（REC）本来就在 bridge 里管，钩子放这儿最顺。
 *
 * 只在 rec-start ~ rec-stop 之间挂载：既是安全考虑（不常驻监听），也不白占资源。
 * 加载失败（缺模块 / 权限 / 杀软拦截）一律优雅降级，绝不拖垮 bridge ——
 * 面板那边的 F9 打点仍然存在，可当兜底。
 */
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);

let lib = null;
let loadErr = "";
let tried = false;

function loadLib() {
  if (tried) return lib;
  tried = true;
  try {
    lib = require2("uiohook-napi");
  } catch (e) {
    loadErr = String((e && e.message) || e);
    lib = null;
  }
  return lib;
}

/** 钩子能不能用（面板据此决定要不要提示用户）。 */
export function hookState() {
  const ok = !!loadLib();
  return { available: ok, error: ok ? "" : loadErr };
}

/* ---- 运行态 ---- */
let running = false;
let onStep = null;
let exclude = [];            // ORB 自己的窗口矩形，落在里面的操作不算
let gesture = null;          // 当前这一"按"：{x0,y0,button,t,clicks,moved,x1,y1,ignored}
let lastStepAt = 0;
let stepCount = 0;
/* 抑制窗口：ORB 自己发起的操作（/api/call、工作流回放、AI 视觉循环）
   会产生**真实**鼠标事件，钩子也看得见。但那些操作已经由 wfCapture 记过了，
   若不抑制就会被记两遍。调用期间把它关掉。 */
let suppressed = false;

export function suppressMouseHook(on) {
  suppressed = !!on;
  if (on) gesture = null;    // 抑制瞬间正在进行的半个手势直接丢弃
}

const BTN = { 1: "left", 2: "right", 3: "middle" };

/* 长按判定阈值（ms）。
 * 普通点击人手通常 80~200ms；按住超过这个值基本可以认定是「有意长按」。
 * 低于它按单击录，高于它按长按录。 */
const LONG_PRESS_MS = 500;

/* 「按住维持」判定阈值（ms）。
 * 一按持续这么久，说明用户在等某个东西（等菜单弹出、等拖拽目标出现），
 * 中间是有节奏的。这种不按长录取，而是拆成 press + release 两步，
 * 让回放时中间能塞进 wait / Snapshot —— 这才是「按住」按钮的本意。
 * 取值要比 LONG_PRESS_MS 明显大一截，否则长按会被误判成维持。 */
const HOLD_MS = 1500;

/** 只取矩形，避免误判：ORB 面板/悬浮球是置顶的，用户点它不算"操作目标软件"。 */
function inExclude(x, y) {
  for (const r of exclude) {
    if (!r) continue;
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return true;
  }
  return false;
}

function emit(step) {
  const now = Date.now();
  step.wait = stepCount === 0 ? 0 : now - lastStepAt;
  lastStepAt = now;
  stepCount++;
  try { onStep && onStep(step); } catch (e) { console.log("[hook] onStep 抛错:", e?.message ?? e); }
}

/* 手势的收尾判定：按下 → 松开之间发生了什么，决定了这是个什么动作。
 *
 * 判定顺序有讲究，从「信息量最大」往下排：
 *   1) 有位移 → 拖动（位移是硬证据，优先）
 *   2) 按得久 → 按住维持（拆 press/release，中间可插步骤）
 *   3) 按得中等久 → 长按（一次原子操作）
 *   4) 其余 → 单击 / 双击 / 右键
 * 顺序错了会互相吃掉：比如把长按判在拖动前面，拖得慢的就会被当成长按。 */

function finishGesture(x, y) {
  const g = gesture;
  gesture = null;
  if (!g || g.ignored) return;

  const btn = BTN[g.button] || "left";
  const held = Date.now() - (g.t || Date.now());   // 这一按持续了多久

  /* 拖动：跨度超过 8px 才算，否则手抖就被当成拖了。
   *
   * 注意这里走的是 orb 原生轨道（server: "orb"）而不是原来的 windows.Move。
   * 原因：windows-mcp 的 Move 只有 loc，没有 from_loc 契约，回放时得先点一下
   * 再移，等于把动作做歪。orb 的 drag 是「从 a 匀速拖到 b」，一比一还原手动操作。
   * 时长取实测值（夹在 120~15000ms），拖得慢回放也慢，手感一致。 */
  if (g.moved > 8) {
    const ms = Math.max(120, Math.min(15000, held));
    emit({
      server: "orb", tool: "drag",
      args: { x: g.x0, y: g.y0, x2: x, y2: y, durationMs: ms, button: btn },
      note: "拖动",
    });
    return;
  }

  /* 按住维持：一按持续很久（≥ HOLD_MS），说明用户在等某个东西。
   *
   * 这种拆成 press + release 两步录，而不是压成一次长按。区别很实在：
   *   · 长按 = 「按住 600ms 然后松」，中间没有别的事，是一次原子操作
   *   · 按住维持 = 「按下 → 干点别的 → 松开」，中间那段才是重点
   * 拆成两步后，回放器（runNode 的默认分支）会顺序执行它们，
   * 你在角色树里就能往中间插入 wait / Snapshot 等步骤。
   * 为了让「中间那段」回放时也有节奏，给 press 步补一个 wait 字段。 */
  if (held >= HOLD_MS && (g.button === 1 || g.button === undefined)) {
    emit({
      server: "orb", tool: "mouse_press",
      args: { x: g.x0, y: g.y0, button: btn },
      note: "按住",
      holdMs: held,
    });
    emit({
      server: "orb", tool: "mouse_release",
      args: { button: btn },
      note: "释放",
    });
    return;
  }

  /* 长按：按住不动、超过阈值才松开 → 这是一次长按，不是单击。
   *
   * 为什么必须区分：长按会唤出右键菜单 / 触发长按选中，而单击不会。
   * 原实现把两者都录成 Click，时长信息整个丢掉，回放出来就是「点了一下」，
   * 菜单根本没出来。阈值取 500ms —— 普通点击人手通常 80~200ms，
   * 500ms 以上基本可以认定是「有意按住」。 */
  if (held >= LONG_PRESS_MS && (g.button === 1 || g.button === undefined)) {
    emit({
      server: "orb", tool: "long_press",
      args: { x: g.x0, y: g.y0, durationMs: held, button: btn },
      note: "长按",
    });
    return;
  }

  const clicks = g.clicks >= 2 ? 2 : 1;
  emit({
    server: "windows", tool: "Click",
    args: { loc: [g.x0, g.y0], clicks, button: btn },
    note: clicks === 2 ? "双击" : (btn === "right" ? "右键" : "单击"),
  });
}

export function startMouseHook(opts = {}) {
  if (running) return { ok: true, already: true };
  const mod = loadLib();
  if (!mod) return { ok: false, error: "全局鼠标钩子不可用：" + loadErr };

  onStep = opts.onStep || null;
  exclude = Array.isArray(opts.exclude) ? opts.exclude.filter(Boolean) : [];
  gesture = null;
  stepCount = 0;
  lastStepAt = Date.now();

  const { uIOhook } = mod;
  const handlers = {
    mousedown: (e) => { if (suppressed) return;
      if (inExclude(e.x, e.y)) { gesture = { ignored: true }; return; }
      gesture = { x0: e.x, y0: e.y, button: e.button, clicks: e.clicks || 1,
                  t: Date.now(), moved: 0, x1: e.x, y1: e.y, ignored: false };
    },
    // 按住时的移动：只更新"拖拽跨度"，不单独成步骤（否则一次录制几万个点）
    mousemove: (e) => { if (suppressed) return;
      if (!gesture || gesture.ignored) return;
      const d = Math.hypot(e.x - gesture.x0, e.y - gesture.y0);
      if (d > gesture.moved) gesture.moved = d;
      gesture.x1 = e.x; gesture.y1 = e.y;
    },
    mousedrag: (e) => { if (suppressed) return;
      if (!gesture || gesture.ignored) return;
      const d = Math.hypot(e.x - gesture.x0, e.y - gesture.y0);
      if (d > gesture.moved) gesture.moved = d;
      gesture.x1 = e.x; gesture.y1 = e.y;
    },
    mouseup: (e) => { if (suppressed) { gesture = null; return; } finishGesture(e.x, e.y); },
    wheel: (e) => { if (suppressed) return;
      if (inExclude(e.x, e.y)) return;
      const horiz = e.direction === 4;          // 4 = 横向滚轮
      const up = (e.rotation ?? 0) > 0;
      const dir = horiz ? (up ? "left" : "right") : (up ? "up" : "down");
      emit({
        server: "windows", tool: "Scroll",
        args: { direction: dir, type: horiz ? "horizontal" : "vertical", wheel_times: 1 },
        note: "滚轮",
      });
    },
  };

  for (const k of Object.keys(handlers)) {
    try { uIOhook.on(k, handlers[k]); } catch (e) { console.log("[hook] 注册 " + k + " 失败:", e?.message ?? e); }
  }
  try {
    uIOhook.start();
  } catch (e) {
    return { ok: false, error: "钩子启动失败：" + ((e && e.message) || e) };
  }
  running = true;
  console.log("[hook] 全局鼠标钩子已挂载" + (exclude.length ? `（排除 ${exclude.length} 个自身区域）` : ""));
  return { ok: true };
}

export function stopMouseHook() {
  if (!running) return { ok: true, steps: 0 };
  const mod = loadLib();
  try { mod && mod.uIOhook && mod.uIOhook.stop(); } catch (e) { console.log("[hook] 停止失败:", e?.message ?? e); }
  running = false;
  onStep = null;
  gesture = null;
  const n = stepCount;
  stepCount = 0;
  console.log("[hook] 钩子已卸载，本次录到 " + n + " 步");
  return { ok: true, steps: n };
}

export function mouseHookRunning() { return running; }
