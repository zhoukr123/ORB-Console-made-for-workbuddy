/*
 * orb-mcp-server —— 把 ORB 的原生能力包成一个标准 MCP server。
 *
 * 为什么需要它：
 *   原先 ORB 的工具分三处：
 *     1) windows-mcp  —— 真 MCP，已在 ~/.workbuddy/mcp.json 注册 → CLI 里的 agent 看得见
 *     2) orb 原生 7 个 —— bridge.mjs 里的 LOCAL_TOOLS，只是「本地伪服务」，
 *        不是 MCP server，agent 完全不知道它们存在
 *     3) OCR / RTSUB —— 面板里的 if 分支，连工具都算不上
 *   结果：对话路径下 agent 只能用 windows-mcp 那 19 个，鼠标的
 *   「按住 / 拖拽 / 长按」这类需要 down-up 分离的操作它根本做不出来
 *   （windows-mcp 只有 Click，等价于 down+up 连发）。
 *
 * 这个 server 把 2) 和 3) 补齐。它直接复用 bridge.mjs 的 LOCAL_TOOLS 实现
 * —— 不重新实现一遍，避免两处逻辑漂移。
 *
 * 传输：stdio（MCP 标准）。stdout 只跑协议帧，诊断一律走 stderr。
 *
 * 注册方式（~/.workbuddy/mcp.json）：
 *   "orb": {
 *     "command": "<node.exe>",
 *     "args": ["<此文件的绝对路径>"]
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_EXE = process.execPath;

/* orb-input.exe：真正干底层鼠标键盘活的原生程序。
 * 找不到就直接退出 —— 与其让 agent 调用时报一堆看不懂的错，
 * 不如启动时就明确说「这个 server 不可用」。 */
function resolveOrbInput() {
  const cands = [
    process.env.ORB_INPUT_EXE,
    path.join(HERE, "native", "dist", "orb-input.exe"),
    path.join(HERE, "native", "dist", "orb-input"),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return "";
}

const ORB_INPUT = resolveOrbInput();
if (!ORB_INPUT) {
  process.stderr.write(
    "[orb-mcp] 找不到 orb-input.exe（试过 native/dist/orb-input.exe）。\n"
    + "[orb-mcp] 这个 server 需要 bridge.mjs 里同款的原生输入程序。\n"
  );
  process.exit(1);
}
process.stderr.write(`[orb-mcp] ORB_INPUT=${ORB_INPUT}\n`);

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

function runOrbInput(argv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(ORB_INPUT, argv.map(String), { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "").trim();
          return reject(new Error(`orb-input 执行失败：${detail || err.code}`));
        }
        resolve({
          content: [{ type: "text", text: String(stdout || "").trim() || "ok" }],
          isError: false,
        });
      });
  });
}

/* ── bridge 侧的本地 HTTP 通道 ──
 * OCR / 实时字幕 是 bridge 进程持有的能力（它管着 Whisper 子进程和截屏管线），
 * 没法在这个独立 server 里复现。所以这两项走回 bridge 的 /api/call。
 * 端口与 token 从 .bridge.json 读 —— bridge 每次启动会写这个文件。 */
function readBridge() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, ".bridge.json"), "utf8"));
    if (j?.port) return j;
  } catch { /* 没启动也正常 */ }
  return null;
}

async function callBridge(tool, args, timeoutMs = 120000) {
  const b = readBridge();
  if (!b) {
    return {
      content: [{ type: "text", text: "ORB 控制台（bridge）没有在运行，OCR / 实时字幕 需要它在线。" }],
      isError: true,
    };
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${b.port}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orb-Token": b.token || "" },
      body: JSON.stringify({ server: "orb", tool, args }),
      signal: ac.signal,
    });
    const j = await r.json();
    if (!j.ok) return { content: [{ type: "text", text: String(j.error || "调用失败") }], isError: true };
    const parts = (j.result?.content || []).map((c) => (c.type === "text" ? c.text : ""));
    return { content: [{ type: "text", text: parts.join("\n") || "ok" }], isError: false };
  } catch (err) {
    return { content: [{ type: "text", text: `调用 bridge 失败：${err?.message ?? err}` }], isError: true };
  } finally {
    clearTimeout(t);
  }
}

/* ── 工具表 ──
 * 参数命名刻意与 windows-mcp 对齐（x/y 为物理像素、button 用 left/right），
 * 这样 agent 在两边之间切换时不需要换一套心智模型。 */
const TOOLS = {
  orb_long_press: {
    desc: "在指定坐标按住鼠标不放一段时间再抬起（长按）。windows-mcp 的 Click 是 down+up 连发，做不出长按，长按菜单/拖拽选择要用这个。",
    input: {
      type: "object",
      properties: {
        x: { type: "number", description: "屏幕物理像素 X" },
        y: { type: "number", description: "屏幕物理像素 Y" },
        durationMs: { type: "number", description: "按住时长（毫秒），默认 800" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "默认 left" },
      },
      required: ["x", "y"],
    },
    run: (a) => {
      const ms = clampInt(a.durationMs ?? a.duration, 1, 60000, 800);
      return runOrbInput(["longpress", clampInt(a.x, -100000, 100000, 0),
        clampInt(a.y, -100000, 100000, 0), ms, a.button ?? "left"], ms + 15000);
    },
  },
  orb_mouse_press: {
    desc: "在指定坐标按下鼠标并保持不放（不做抬起）。配合 orb_mouse_release 可完成任意拖拽。x/y 传 -1 表示就地按下、不移动光标。",
    input: {
      type: "object",
      properties: {
        x: { type: "number", description: "X，-1 表示就地" },
        y: { type: "number", description: "Y，-1 表示就地" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "默认 left" },
      },
    },
    run: (a) => runOrbInput(["press", clampInt(a.x, -100000, 100000, -1),
      clampInt(a.y, -100000, 100000, -1), a.button ?? "left"]),
  },
  orb_mouse_release: {
    desc: "释放鼠标按键。与 orb_mouse_press 配对使用。",
    input: {
      type: "object",
      properties: {
        button: { type: "string", enum: ["left", "right", "middle"], description: "默认 left" },
      },
    },
    run: (a) => runOrbInput(["release", a.button ?? "left"]),
  },
  orb_drag: {
    desc: "从 (x,y) 拖到 (x2,y2)，带时长参数所以是平滑拖拽（拖文件、拖滑块、框选都用它）。",
    input: {
      type: "object",
      properties: {
        x: { type: "number" }, y: { type: "number" },
        x2: { type: "number" }, y2: { type: "number" },
        durationMs: { type: "number", description: "拖拽耗时（毫秒），默认 400" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "默认 left" },
      },
      required: ["x", "y", "x2", "y2"],
    },
    run: (a) => {
      const ms = clampInt(a.durationMs, 0, 20000, 400);
      return runOrbInput(["drag",
        clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
        clampInt(a.x2, -100000, 100000, 0), clampInt(a.y2, -100000, 100000, 0),
        ms, a.button ?? "left"], ms + 15000);
    },
  },
  orb_move_to: {
    desc: "把鼠标指针移动到指定坐标（只移动，不点击）。",
    input: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    run: (a) => runOrbInput(["move", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0)]),
  },
  orb_cursor_position: {
    desc: "读取鼠标指针当前的屏幕物理像素坐标。不确定该点哪里时先调它。",
    input: { type: "object", properties: {} },
    run: () => runOrbInput(["cursor"]),
  },
  orb_scroll_at: {
    desc: "在指定坐标处滚动滚轮（不移动光标到别处）。比 windows-mcp 的 Scroll 更适合「滚某个特定列表」。",
    input: {
      type: "object",
      properties: {
        x: { type: "number" }, y: { type: "number" },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "默认 down" },
        clicks: { type: "number", description: "滚动格数，默认 3" },
      },
      required: ["x", "y"],
    },
    run: (a) => runOrbInput(["scroll", clampInt(a.x, -100000, 100000, 0),
      clampInt(a.y, -100000, 100000, 0), a.direction ?? "down", clampInt(a.clicks, 1, 100, 3)]),
  },
  orb_ocr: {
    desc: "截取屏幕并对指定区域做 OCR 取词，返回识别出的文字。需要 ORB 控制台（bridge）在线。",
    input: {
      type: "object",
      properties: {
        x: { type: "number", description: "可选：区域左上 X" },
        y: { type: "number", description: "可选：区域左上 Y" },
        w: { type: "number", description: "可选：区域宽" },
        h: { type: "number", description: "可选：区域高" },
      },
    },
    run: (a) => callBridge("OCR", a),
  },
  orb_subtitle: {
    desc: "开关 ORB 的实时字幕（把系统声音转成屏幕上的字幕条）。action=start/stop/toggle。需要 bridge 在线。",
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "toggle"], description: "默认 toggle" },
      },
    },
    run: (a) => callBridge("RTSUB", a),
  },
};

const TOOL_NAMES = Object.keys(TOOLS);

const server = new Server(
  { name: "orb", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_NAMES.map((name) => ({
    name,
    description: TOOLS[name].desc,
    inputSchema: TOOLS[name].input,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const def = TOOLS[name];
  if (!def) {
    return {
      content: [{ type: "text", text: `orb 没有工具 ${name}（可用：${TOOL_NAMES.join(", ")}）` }],
      isError: true,
    };
  }
  try {
    return await def.run(args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[orb-mcp] 就绪，${TOOL_NAMES.length} 个工具\n`);
