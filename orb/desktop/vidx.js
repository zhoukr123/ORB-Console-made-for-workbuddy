/* ---------------- 看视频：解析管道 ----------------
 * 职责：把一个「视频/音频来源」变成 Agent 能直接读的一坨文本产物。
 *
 *   来源 ──► 探底 ──► 抽帧 ──►（可选）台词 ──► index.md / timeline.md
 *                                                     ▲
 *                                             Agent 只读这两个
 *
 * 为什么必须有这一层，而不能"把路径丢给后台 Agent"：
 *   后台 Agent 拿到一个 mp4 路径什么也做不了 —— 它没有解码能力，只能瞎猜。
 *   所以视频必须在派发之前就地变成文字 + 截图，这一步没法外包给 Agent。
 *
 * 运行时（B 方案）：
 *   探底/抽帧只需要 PyAV（av 包，自带 FFmpeg 共享库，约 60 MB），和 2.1 GB 的
 *   语音识别环境**完全解耦**。三档来源依次尝试：
 *     ① <userData>/vidxrt      —— 本功能专属的精简运行时（推荐，~200 MB）
 *     ② asr/venv               —— 用户已经装了本地识别，里面的 av 直接借用（零额外磁盘）
 *     ③ 都没有                  —— 面板显示"未安装"，引导装 ①
 *   注意 ② 只是"顺手复用"，不是依赖：没装 ASR 的用户装 ① 一样能看视频。
 *
 * 硬约定：
 *   · 本模块**不在顶层**碰任何 ready-gated API（app.getPath / net 都只在调用点取）；
 *   · 长任务全程只有一个"当前任务"，用状态查询轮询取进度，不往渲染层推流；
 *   · 任何阶段失败都要把已完成的部分留下（半份产物比没有强），并在 meta 里写清原因。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PY_SCRIPT = path.join(__dirname, "vidx_probe.py");
const RT_DIRNAME = "vidxrt";          // 专属运行时目录（放在 userData，不跟存储根走）
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const FRAME_INTERVAL = 5;             // 秒
const FRAME_MAX = 200;                // 上限：超过就自动拉稀间隔，避免 3 小时片子抽出 2000 张
const FRAME_WIDTH = 960;

/* ---------------- 台词回顾（大模型纠错） ----------------
 * 为什么要有这一步：识别引擎解决的是「听清」，不是「听懂」。
 * 同音字（"在座"→"再做"）、专有名词（人名/产品名/机构名）、数字与单位、
 * 连读造成的断句错误——这四类错误，靠声学模型几乎没有再提升的空间，
 * 但语言模型看上下文一眼就能改对，而且是这批错误里最便宜的一种修法。
 *
 * 边界必须钉死：它只许改字，不许改意。改错一句比不改更糟，
 * 因为下游（Agent 总结、字幕、检索）会把错的当成事实。
 * 所以提示词里写的是"不确定就不改、不许润色、不许合并拆分"，
 * 代码里做的是"只接受能对回原序号的改动"。
 */
const REVIEW_BATCH_LINES = 30;        // 一次送多少句：再多的话 JSON 容易截断
const REVIEW_MAX_BATCHES = 12;        // 上限约 360 句；超出的不回顾（宁可半份，不要烧钱）
const REVIEW_BATCH_MS = 90000;        // 单批超时
const REVIEW_TOTAL_MS = 360000;       // 总上限：整片回顾不能比抽帧还慢

/* ---------------- 热词（专有名词提示） ----------------
 * 为什么热词值这个钱：识别引擎解决「听清」，同音字（"宿组"↔"数组"）它自己永远
 * 分不出来——除非提前告诉它这片子可能说什么词。热词来源分两级：
 *   1. B 站片源：UP 主打的 tags + 标题 + 简介（都是现成的，一次 API 调用）；
 *   2. 对话模型提炼：把上述材料交给它挑出「人名/产品名/术语」，失败就退回
 *      「tags 原文 + 标题里较长的词」——宁可用糙一点的词表，也不能没有。
 * 热词去向也是两级：转写时喂给 ASR（whisper 引擎拼进 initial_prompt），
 * 回顾时喂给校对模型（它拿着权威写法才敢把 suspects 升级成 fixes）。 */
const HOTWORD_MAX = 24;               // 词表上限：塞太多反而稀释权重
const HOTWORDS_MS = 30000;            // 提炼超时：这道工序不配比转写还贵

/** 从 B 站 view/detail 接口拿 tags（UP 主自打的标签，比标题更专业向）。
 *  失败返回空数组——tags 是锦上添花，不值得为它失败。 */
async function biliTags(bvid) {
  try {
    const r = await httpText(
      "https://api.bilibili.com/x/web-interface/view/detail/tag?bvid=" + bvid,
      { "User-Agent": UA, Referer: "https://www.bilibili.com/" }
    );
    const j = JSON.parse(r.body);
    if (!j || j.code !== 0 || !Array.isArray(j.data)) return [];
    return j.data.map((t) => String(t && t.tag_name || "").trim()).filter(Boolean);
  } catch { return []; }
}

/** 标题兜底切词：挑长度 ≥2 的连续非符号段。不需要分词库——
 *  「数组排序」这种连写词切不开也没关系，标题本来就整段喂给模型提炼过了。 */
function wordsFromText(text) {
  return String(text || "")
    .replace(/[【】\[\]（）()「」『』《》〔〕|｜/／\\,:：;；!！?？~～"'·…—\s]+/g, "\n")
    .split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 20);
}

/** 汇总热词。bili 可为 null（本地文件）；meta 摘要和回顾提示词共用这份词表。
 *  绝不抛异常：热词是增强，不是依赖。 */
async function collectHotwords(title, bili, slot) {
  const srcTags = bili ? bili.tags || [] : [];
  const desc = bili ? String(bili.desc || "").slice(0, 400) : "";
  const raw = [...new Set([...srcTags, ...wordsFromText(title)])];
  if (!raw.length && !desc) return [];
  let words = raw.slice(0, HOTWORD_MAX);

  /* 有对话模型就让它提炼：去掉"欧美MV/流行音乐"这类宽泛分类词，留下真专名。
     失败/超时/没解析出 JSON 一律静默退回原文词表——这条链路不允许报错打断解析。 */
  if (slot) {
    const L = ["请从以下视频信息里挑出「专有名词」：人名、产品名、技术术语、作品名、机构名。",
      "去掉宽泛的分类词（如「音乐」「教程」「评测」）和纯数字。最多 20 个，按相关度排序。",
      "只输出 JSON，不要解释：", '{"words":["词1","词2"]}'];
    if (title) L.push("标题：" + title);
    if (srcTags.length) L.push("标签：" + srcTags.slice(0, 15).join("、"));
    if (desc) L.push("简介：" + desc.slice(0, 200));
    try {
      const r = await postChat(slot, "你是信息抽取器。只输出 JSON。", L.join("\n"), HOTWORDS_MS);
      const j = extractJson(r.content);
      const arr = Array.isArray(j && j.words) ? j.words : [];
      const picked = arr.map((w) => String(w || "").trim()).filter((w) => w && w.length <= 20);
      if (picked.length) words = picked;
    } catch { /* 退回 raw */ }
  }
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(w); }
    if (out.length >= HOTWORD_MAX) break;
  }
  return out;
}

/* 宿主上下文由 main.js 注入 —— 本模块自己不去问 app.getPath，
   否则会撞上 app.setPath 的执行时机，早调用就落到默认目录去了。 */
let ctx = {
  userData: () => "",
  vidxDir: () => "",
  getState: () => ({}),
  /* 台词回顾用的对话模型。返回 { baseUrl, model, apiKey, extra } 或 null。
     为什么由宿主注入而不在这里读 state：密钥在 vault（密文）里，
     只有主进程那条受控通道取得出明文，模块自己伸手去读会读到空串。 */
  model: () => null,
  log: () => {},
};

function init(next) {
  if (!next || typeof next !== "object") return;
  if (typeof next.userData === "function") ctx.userData = next.userData;
  if (typeof next.vidxDir === "function") ctx.vidxDir = next.vidxDir;
  if (typeof next.getState === "function") ctx.getState = next.getState;
  if (typeof next.model === "function") ctx.model = next.model;
  if (typeof next.log === "function") ctx.log = next.log;
}

function note(...args) {
  try { ctx.log("[vidx]", ...args); } catch { /* 日志不能反咬调用方 */ }
}

const errText = (e) => (e && e.message) ? e.message : String(e);

function safeDir(fn) {
  try { const d = fn(); return typeof d === "string" ? d : ""; } catch { return ""; }
}

/* ---------------- 运行时定位 ---------------- */

function rtPython() {
  const base = safeDir(ctx.userData);
  if (!base) return "";
  const p = path.join(base, RT_DIRNAME, "Scripts", "python.exe");
  try { return fs.existsSync(p) ? p : ""; } catch { return ""; }
}

function asrPython() {
  const base = safeDir(ctx.userData);
  if (!base) return "";
  // .orbdata 在 desktop 下，asr/venv 在项目根
  const p = path.join(base, "..", "..", "..", "asr", "venv", "Scripts", "python.exe");
  try { return fs.existsSync(path.resolve(p)) ? path.resolve(p) : ""; } catch { return ""; }
}

/** 跑一次 `python -c "import av, numpy"`，确认这个解释器真的能用。
 *  为什么不能只看文件在不在：venv 半装（pip 中断）时 python.exe 是存在的，
 *  但 import 会失败 —— 那时候报"已安装"只会把用户带到更难查的错上。 */
function probePython(py) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(py, ["-c", "import av,sys;print(av.__version__)"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return finish({ ok: false, error: errText(e) });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish({ ok: false, error: "探测超时" });
    }, 15000);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: errText(e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true, avVersion: out.trim() });
      else finish({ ok: false, error: (err || out || "退出码 " + code).trim().slice(0, 300) });
    });
  });
}

let rtCache = null;   // { at, status } —— 探测要 spawn 一个进程，不能每次点都跑

/** 当前可用的运行时。kind: dedicated | borrowed | none */
async function runtimeStatus(force) {
  if (!force && rtCache && Date.now() - rtCache.at < 60000) return rtCache.status;
  const dedicated = rtPython();
  if (dedicated) {
    const r = await probePython(dedicated);
    if (r.ok) return cache({ ok: true, kind: "dedicated", python: dedicated, avVersion: r.avVersion });
    note("专属运行时不可用：", r.error);
  }
  const borrowed = asrPython();
  if (borrowed) {
    const r = await probePython(borrowed);
    if (r.ok) return cache({ ok: true, kind: "borrowed", python: borrowed, avVersion: r.avVersion });
    note("本地识别环境里的 av 不可用：", r.error);
  }
  return cache({
    ok: false,
    kind: "none",
    python: "",
    error: dedicated
      ? "专属运行时装了一半（python 在，但 import av 失败），建议重装"
      : "本机还没有看视频需要的运行时",
  });

  function cache(s) { rtCache = { at: Date.now(), status: s }; return s; }
}

/* ---------------- 专属运行时的安装 ---------------- */

/** 找一个能用来建 venv 的系统 Python（不是 asr/venv —— 那个已经是人家的环境了）。 */
function findSystemPython() {
  const cands = [];
  if (process.env.ORB_PYTHON) cands.push(process.env.ORB_PYTHON);
  cands.push("py", "python", "python3");
  return cands;
}

function runProc(exe, args, onLine, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, code: -1, out: "", err: errText(e) });
    }
    let out = "";
    let err = "";
    const feed = (buf, isErr) => {
      const s = buf.toString();
      if (isErr) err += s; else out += s;
      if (onLine) {
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) { try { onLine(line.trim(), isErr); } catch { /* 回调出错不影响 */ } }
        }
      }
    };
    child.stdout.on("data", (b) => feed(b, false));
    child.stderr.on("data", (b) => feed(b, true));
    child.on("error", (e) => resolve({ ok: false, code: -1, out, err: err + errText(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

/** 建专属运行时：系统 Python → venv → pip install av numpy。
 *  只装两个包，不装 faster-whisper（那是语音识别的事，不该由看视频承担）。 */
async function installRuntime(onStep) {
  const step = (msg, pct) => { try { onStep && onStep({ msg, pct }); } catch { /* ignore */ } };
  const base = safeDir(ctx.userData);
  if (!base) return { ok: false, error: "拿不到数据目录" };
  const dir = path.join(base, RT_DIRNAME);
  const py = path.join(dir, "Scripts", "python.exe");
  if (fs.existsSync(py)) {
    const chk = await probePython(py);
    if (chk.ok) return { ok: true, already: true, python: py };
  }

  step("正在找系统 Python…", 4);
  let used = null;
  for (const exe of findSystemPython()) {
    const r = await runProc(exe, ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"], null);
    if (r.ok) { used = exe; break; }
  }
  if (!used) {
    return {
      ok: false,
      error: "本机没有可用的 Python。请先装 Python 3.10+（勾选 Add to PATH），或改装「本地离线识别」后借它的环境。",
    };
  }

  step("正在创建隔离环境…", 12);
  const mk = await runProc(used, ["-m", "venv", dir], (line) => step(line, 16));
  if (!mk.ok || !fs.existsSync(py)) {
    return { ok: false, error: "创建虚拟环境失败：" + (mk.err || mk.out || "未知原因").slice(0, 300) };
  }

  step("正在下载并安装 PyAV（约 60 MB）…", 30);
  /* 先升 pip 再装：老 pip 会因为 av 只发 wheel、拒绝源码构建而报一堆看不懂的错 */
  await runProc(py, ["-m", "pip", "install", "--upgrade", "pip", "--disable-pip-version-check"], null, dir);
  const pip = await runProc(
    py,
    ["-m", "pip", "install", "--disable-pip-version-check", "av>=11", "numpy"],
    (line) => step(line, 55),
    dir
  );
  if (!pip.ok) {
    return { ok: false, error: "安装 av/numpy 失败：" + (pip.err || pip.out || "").slice(-400) };
  }

  step("正在验证…", 90);
  const chk = await probePython(py);
  if (!chk.ok) return { ok: false, error: "装完了但 import av 仍失败：" + chk.error };
  rtCache = null;
  step("完成", 100);
  return { ok: true, python: py, avVersion: chk.avVersion };
}

/* ---------------- 官方接口 / 下载 ---------------- */

function netRequest(opts) {
  const { net } = require("electron");
  return net.request(opts);
}

/** 用一个请求把响应读成字符串（JSON 接口用）。url 字段是最终地址（跟完 3xx 后），
 *  短链场景里靠它拿回被跳转吃掉的 p=分集参数。 */
function httpText(url, headers) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = netRequest({ url, method: "GET", redirect: "follow" });
    } catch (e) {
      return reject(e);
    }
    for (const [k, v] of Object.entries(headers || {})) { try { req.setHeader(k, v); } catch { /* 非法头忽略 */ } }
    req.on("response", (res) => {
      let body = "";
      res.on("data", (b) => { body += b.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers, url: (res && res.url) || url }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** 流式下载到文件。绝不 arrayBuffer —— 一个 300 MB 的片子会直接把内存顶爆。 */
function httpDownload(url, dest, headers, onProgress) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = netRequest({ url, method: "GET", redirect: "follow" });
    } catch (e) {
      return reject(e);
    }
    for (const [k, v] of Object.entries(headers || {})) { try { req.setHeader(k, v); } catch { /* 非法头忽略 */ } }
    req.on("response", (res) => {
      if (res.statusCode >= 400) {
        res.on("data", () => {});
        return reject(new Error("HTTP " + res.statusCode));
      }
      const total = Number(res.headers["content-length"] || 0);
      const ws = fs.createWriteStream(dest);
      let got = 0;
      let failed = false;
      ws.on("error", (e) => { failed = true; try { req.abort(); } catch { /* 已断 */ } reject(e); });
      res.on("data", (chunk) => {
        got += chunk.length;
        if (!ws.write(chunk)) {
          res.pause();
          ws.once("drain", () => res.resume());
        }
        if (onProgress) { try { onProgress(got, total); } catch { /* ignore */ } }
      });
      res.on("end", () => { ws.end(() => { if (!failed) resolve({ bytes: got }); }); });
      res.on("error", (e) => { failed = true; reject(e); });
    });
    req.on("error", reject);
    req.end();
  });
}

/** 从各种写法的链接里抠出 bvid（b23.tv 短链要发一次请求才知道去哪）。
 *  支持分集：链接里带 ?p=N 就解析第 N 集（多 P 合集在 B 站极常见，分享链接常定位到某一集）。 */
async function resolveBili(url) {
  let target = url;
  let p = 1;
  const pm = String(url).match(/[?&]p=(\d+)/i);
  if (pm) p = Math.max(1, parseInt(pm[1], 10));
  if (/b23\.tv/i.test(url)) {
    const r = await httpText(url, { "User-Agent": UA });
    /* 短链落地页是 gzip 二进制（r.body 非空但不是文本），BV 号和 p 分集要从
       跳转后的最终地址 r.url 里抠——那里一定有 BV，且分享链接常带 p=。 */
    const rurl = String(r.url || "");
    const m = rurl.match(/BV[0-9A-Za-z]{10}/) || String(r.body || "").match(/BV[0-9A-Za-z]{10}/);
    if (!m) return null;
    target = "https://www.bilibili.com/video/" + m[0];
    const pu = rurl.match(/[?&]p=(\d+)/i);
    if (pu) p = Math.max(1, parseInt(pu[1], 10));
  }
  const m = String(target).match(/BV[0-9A-Za-z]{10}/);
  if (!m) return null;
  const bvid = m[0];
  const ref = "https://www.bilibili.com/";
  const view = await httpText(
    "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid,
    { "User-Agent": UA, Referer: ref }
  );
  let vj;
  try { vj = JSON.parse(view.body); } catch { return null; }
  if (!vj || vj.code !== 0 || !vj.data) return null;
  /* 多 P：按 p 选 cid；单 P 或越界就退回第一集。 */
  let cid = vj.data.cid, pageDur = vj.data.duration, part = "";
  const pages = Array.isArray(vj.data.pages) ? vj.data.pages : [];
  if (pages.length > 1) {
    const pg = pages[Math.min(p, pages.length) - 1];
    if (pg) { cid = pg.cid; pageDur = pg.duration; part = pg.part || ""; }
  }
  const title = String(vj.data.title || bvid) + (part ? (" 〔P" + p + " " + part + "〕") : "");
  const play = await httpText(
    "https://api.bilibili.com/x/player/playurl?bvid=" + bvid + "&cid=" + cid + "&qn=64&fnval=16&fourk=1",
    { "User-Agent": UA, Referer: ref }
  );
  let pj;
  try { pj = JSON.parse(play.body); } catch { return null; }
  const dash = pj && pj.data && pj.data.dash;
  if (!dash || !dash.video || !dash.video.length) return null;
  /* DASH 音视频分离：画面取码率最低的那档就够抽帧（省带宽也省时间），
     音频单独取一条给 ASR。baseUrl 两小时过期，所以只在内存里用、绝不落盘存档。 */
  const vids = [...dash.video].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  const aud = (dash.audio || [])[0];
  /* 热词素材：UP 主打的 tags + 简介。都是现成字段，一次轻量请求；
     失败只损失热词质量，不影响解析主流程。 */
  let tags = [], desc = "";
  try {
    const tj = await httpText(
      "https://api.bilibili.com/x/web-interface/view/detail/tag?bvid=" + bvid,
      { "User-Agent": UA, Referer: ref }
    );
    const tt = JSON.parse(tj.body);
    if (tt && tt.code === 0 && Array.isArray(tt.data)) {
      tags = tt.data.map((t) => String(t && t.tag_name || "").trim()).filter(Boolean);
    }
  } catch { /* tags 拿不到就算了 */ }
  desc = String(vj.data.desc || "").trim();
  return {
    title,
    bvid,
    referer: ref,
    videoUrl: vids[0].baseUrl || vids[0].base_url,
    audioUrl: aud ? (aud.baseUrl || aud.base_url) : "",
    durationSec: Number(pageDur) || 0,
    page: p, part,
    tags, desc,
  };
}

/* ---------------- 产物编排 ---------------- */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

function writeJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 跑一次 vidx_probe.py 的子命令，从 <<<ORB ... ORB>>> 之间取 JSON。 */
function runProbe(py, args, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(py, [PY_SCRIPT, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: errText(e) });
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => {
      const s = b.toString("utf8");
      err += s;
      if (onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) { try { onLine(line.trim()); } catch { /* ignore */ } }
    });
    child.on("error", (e) => resolve({ ok: false, error: errText(e) }));
    child.on("close", () => {
      const m = out.match(/<<<ORB\r?\n([\s\S]*?)\r?\nORB>>>/);
      if (!m) return resolve({ ok: false, error: (err || out || "脚本没有输出结果").slice(-400) });
      try { resolve(JSON.parse(m[1])); }
      catch (e) { resolve({ ok: false, error: "解析脚本输出失败：" + errText(e) }); }
    });
  });
}

/* 当前任务状态：面板用 vidx-status 轮询它。同一时刻只跑一个，
   因为抽帧是重 IO + 重 CPU，并行两个只会都变慢。 */
let job = null;

function status() {
  if (!job) return { ok: true, running: false };
  return {
    ok: true,
    running: !!job.running,
    key: job.key,
    phase: job.phase,
    pct: Math.round(job.pct || 0),
    msg: job.msg || "",
    error: job.error || "",
    dir: job.dir || "",
    index: job.indexPath || "",
    title: job.title || "",
    frames: job.frameCount || 0,
    hasTranscript: !!job.hasTranscript,
    startedAt: job.startedAt,
  };
}

function setPhase(phase, pct, msg) {
  if (!job) return;
  job.phase = phase;
  job.pct = pct;
  job.msg = msg || job.msg;
}

/**
 * 解析一个来源。src: { kind:'file'|'url', value, title? }
 * 返回最终状态；产物落在 <vidx>/<key>/。
 */
async function run(src) {
  if (job && job.running) return { ok: false, error: "已经有一个解析任务在跑，等它结束再来" };
  const input = src && typeof src === "object" ? src : {};
  const kind = input.kind === "url" ? "url" : "file";
  const value = String(input.value || "").trim();
  if (!value) return { ok: false, error: "没有内容可解析" };

  const root = safeDir(ctx.vidxDir);
  if (!root) return { ok: false, error: "拿不到看视频目录（存储根可能无效）" };

  job = {
    running: true, key: stamp() + "-" + Math.random().toString(36).slice(2, 6),
    phase: "start", pct: 0, msg: "准备中…", startedAt: Date.now(),
    title: "", dir: "", indexPath: "", frameCount: 0, hasTranscript: false, error: "",
    reviewed: false, reviewChanged: 0, suspects: 0,
  };

  try {
    const rt = await runtimeStatus(true);
    if (!rt.ok) {
      job.running = false;
      job.error = "需要先安装看视频运行时（约 200 MB，只含 PyAV，与语音识别无关）";
      setPhase("error", 0, job.error);
      return { ok: false, error: job.error, needRuntime: true };
    }

    const dir = path.join(root, job.key);
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    job.dir = dir;

    /* ---- 1. 取到本地文件 ---- */
    let mediaPath = "";
    let origin = "";
    let audioPath = "";
    let bili = null;

    if (kind === "file") {
      if (!fs.existsSync(value)) throw new Error("文件不存在：" + value);
      mediaPath = value;
      origin = "本地文件：" + value;
      job.title = path.basename(value);
      setPhase("probe", 10, "读取媒体信息…");
    } else {
      origin = "链接：" + value;
      if (/bilibili\.com|b23\.tv/i.test(value)) {
        setPhase("resolve", 4, "解析 B 站视频地址…");
        bili = await resolveBili(value);
        if (!bili) throw new Error("这个 B 站链接没解析出可播放的地址（可能是番剧/付费内容）");
        job.title = bili.title;
        const vdest = path.join(dir, "media", "video.m4s");
        fs.mkdirSync(path.dirname(vdest), { recursive: true });
        setPhase("download", 10, "下载视频流…");
        await httpDownload(bili.videoUrl, vdest, { "User-Agent": UA, Referer: bili.referer }, (got, total) => {
          const p = total ? Math.min(30, 10 + (got / total) * 20) : 10;
          job.pct = p; job.msg = "下载视频流 " + Math.round(got / 1048576) + "MB";
        });
        mediaPath = vdest;
        if (bili.audioUrl) {
          const adest = path.join(dir, "media", "audio.m4s");
          setPhase("download", 32, "下载音频流…");
          try {
            await httpDownload(bili.audioUrl, adest, { "User-Agent": UA, Referer: bili.referer }, (got, total) => {
              const p = total ? Math.min(46, 32 + (got / total) * 14) : 32;
              job.pct = p; job.msg = "下载音频流 " + Math.round(got / 1048576) + "MB";
            });
            audioPath = adest;
          } catch (e) {
            note("音频流下载失败（不影响画面）:", errText(e));
          }
        }
      } else {
        const dest = path.join(dir, "media", "source.bin");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        setPhase("download", 8, "下载…");
        await httpDownload(value, dest, { "User-Agent": UA }, (got, total) => {
          const p = total ? Math.min(40, 8 + (got / total) * 32) : 8;
          job.pct = p; job.msg = "下载中 " + Math.round(got / 1048576) + "MB";
        });
        mediaPath = dest;
        job.title = job.title || path.basename(new URL(value).pathname) || "网络视频";
      }
    }

    /* ---- 2. 探底 ---- */
    setPhase("probe", 48, "探底…");
    const meta = await runProbe(rt.python, ["probe", mediaPath]);
    if (!meta.ok) throw new Error(meta.error || "探底失败");
    /* 热词：B 站片源拿 tags/简介，本地文件用文件名；有对话模型就提炼一遍（约 3 秒，
       失败退回原文词表）。放在探底后、下载转写前——它只依赖标题，越早收越好。
       绝不因热词失败中断解析：热词是增强，不是依赖。 */
    try {
      setPhase("probe", 50, "收集热词…");
      job.hotwords = await collectHotwords(job.title, bili, modelSlot());
      if (job.hotwords.length) note("热词:", job.hotwords.join("、"));
    } catch { job.hotwords = []; }
    /* DASH 片源（B 站）音视频是两个文件：probe 扫的是 video.m4s，它里面当然没有音轨。
       直接把 probe 的结果当"这个片有没有声音"就会错判成"无音轨"——
       所以这里用「有没有单独下载到音频流」把它补回去，并单独记一个 audioSeparate。
       这两个字段语义不同：hasAudio=这片源有没有声音，audioSeparate=声音在不在另一个文件里。 */
    const audioSeparate = !!audioPath;
    meta.hasAudio = audioSeparate || !!meta.hasAudio;
    meta.audioSeparate = audioSeparate;
    writeJson(path.join(dir, "meta.json"), {
      key: job.key,
      title: job.title,
      origin,
      source: kind === "file" ? { kind: "file", path: value } : { kind: "url", url: value },
      bvid: bili ? bili.bvid : "",
      probedAt: new Date().toISOString(),
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      videoCodec: meta.videoCodec,
      hasAudio: !!meta.hasAudio,
      audioSeparate,
      audioFrom: audioSeparate ? "独立音频流" : (meta.hasAudio ? "同容器" : "无"),
      sizeBytes: meta.sizeBytes,
      avVersion: meta.avVersion,
      hotwords: job.hotwords || [],
    });

    /* ---- 3. 抽帧 ---- */
    /* 长片子按上限反推间隔：3 小时的片如果还按 5 秒抽就是 2160 张，
       视觉模型根本看不过来，磁盘也白占。间隔上限 60 秒。 */
    const dur = Number(meta.durationSec) || 0;
    let interval = FRAME_INTERVAL;
    if (dur > FRAME_INTERVAL * FRAME_MAX) {
      interval = Math.min(60, Math.ceil(dur / FRAME_MAX));
    }
    setPhase("frames", 55, `抽帧（每 ${interval} 秒一张）…`);
    const fr = await runProbe(
      rt.python,
      ["frames", mediaPath, path.join(dir, "frames"), "--interval", String(interval), "--max", String(FRAME_MAX), "--width", String(FRAME_WIDTH)],
      (line) => { if (/scan /.test(line)) job.msg = "抽帧：" + line.replace("scan ", ""); }
    );
    if (!fr.ok) throw new Error(fr.error || "抽帧失败");
    job.frameCount = fr.count || 0;
    writeJson(path.join(dir, "frames.json"), {
      interval, maxWidth: FRAME_WIDTH, count: fr.count, partial: !!fr.partial,
      frames: fr.frames || [], elapsedSec: fr.elapsedSec,
    });

    /* ---- 4. 台词（可选） ---- */
    let transcript = null;
    const wavSource = audioPath || (meta.hasAudio ? mediaPath : "");
    if (wavSource) {
      setPhase("audio", 72, "提取音轨…");
      const wav = path.join(dir, "audio.wav");
      const ar = await runProbe(rt.python, ["audio", wavSource, wav]);
      if (ar.ok) {
        setPhase("asr", 78, "转写台词（可能要一会儿）…");
        transcript = await transcribe(wav, meta.durationSec, job.hotwords);
        if (transcript && transcript.ok) {
          job.hasTranscript = true;
          /* 先落一份原始转写：回顾这一步可能超时、可能接口不通，
             但「这段片子有台词」这件事不能因为回顾失败而丢。 */
          writeJson(path.join(dir, "transcript.json"), transcript);
          setPhase("review", 88, "回顾台词（校正同音字、专名、数字）…");
          const rv = await reviewTranscript(transcript, meta, job.title, job.hotwords || []);
          if (rv.ok) {
            job.reviewed = true;
            job.reviewChanged = rv.changed;
            job.suspects = rv.suspects || 0;
            /* 改写后的版本覆盖同一份 transcript.json；原文留在每段的 textRaw 里可回溯，
               疑似项留在 suspect 里（**没有动 text**，只是标注）。 */
            writeJson(path.join(dir, "transcript.json"), transcript);
            note("台词回顾:", rv.model, "改动", rv.changed, "段 / 疑似", rv.suspects || 0,
              "处 / 覆盖", rv.covered, "段，耗时", rv.ms + "ms");
          } else {
            note("台词回顾跳过（保留原始转写）:", rv.error);
          }
        } else if (transcript) {
          note("转写未完成:", transcript.error);
        }
      } else {
        note("取音轨失败:", ar.error);
      }
    }

    /* ---- 5. 写给人（和 Agent）看的两个文件 ---- */
    setPhase("compose", 94, "生成索引…");
    const frames = fr.frames || [];
    const idx = path.join(dir, "index.md");
    fs.writeFileSync(idx, buildIndex({ job, meta, frames, interval, transcript, origin }), "utf8");
    fs.writeFileSync(path.join(dir, "timeline.md"), buildTimeline({ meta, frames, transcript }), "utf8");
    job.indexPath = idx;

    job.running = false;
    setPhase("done", 100, "完成");
    note("解析完成:", job.key, "帧", job.frameCount, transcript && transcript.ok ? "含台词" : "无台词");
    return {
      ok: true, dir, index: idx, key: job.key, frames: job.frameCount,
      hasTranscript: !!job.hasTranscript, reviewed: !!job.reviewed,
      reviewChanged: job.reviewChanged || 0, suspects: job.suspects || 0, title: job.title,
    };
  } catch (e) {
    const msg = errText(e);
    job.running = false;
    job.error = msg;
    setPhase("error", job.pct || 0, msg);
    note("解析失败:", msg);
    return { ok: false, error: msg };
  }
}

/** 调本地识别服务转写。它不在就明确说"没转"，绝不假装有台词。

    服务端（asr_server.py）有两条引擎：SenseVoice 会额外回 emotions/events，
    whisper 只回文字。这里**照单全收**——没有情绪就当没有，绝不补默认值，
    否则 Agent 会把"平静"当成事实说出来。 */
async function transcribe(wavPath, durationSec, hotwords) {
  const st = (() => { try { return ctx.getState() || {}; } catch { return {}; } })();
  const ep = (st.voice && st.voice.endpoint) || "http://127.0.0.1:19876/v1/audio/transcriptions";
  let buf;
  try { buf = fs.readFileSync(wavPath); } catch (e) { return { ok: false, error: "读不到音频：" + errText(e) }; }
  try {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "audio/wav" }), path.basename(wavPath));
    fd.append("model", "whisper-1");
    /* 请求级热词：whisper 引擎拼进 initial_prompt；sensevoice 引擎不识别就忽略
       （FastAPI Form 多收一个字段不报错），所以这里不用关心对面是哪条引擎。 */
    if (Array.isArray(hotwords) && hotwords.length) {
      fd.append("hotwords", hotwords.slice(0, HOTWORD_MAX).join(","));
    }
    const ac = new AbortController();
    /* 超时按片长给，最低 3 分钟：0.2× 实时意味着 1 小时音频要 12 分钟 */
    const limit = Math.max(180000, Math.round((Number(durationSec) || 600) * 1000 * 0.5));
    const timer = setTimeout(() => ac.abort(), limit);
    const res = await fetch(ep, { method: "POST", body: fd, signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: "识别服务返回 HTTP " + res.status };
    const j = await res.json();
    const segs = Array.isArray(j.segments) ? j.segments.map((s) => {
      const o = {
        start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || "").trim(),
      };
      /* 情绪按段带回来：一句话一个判断，整片只给一个"总体情绪"没有意义 */
      if (s.emotion) { o.emotion = String(s.emotion); o.emotionZh = String(s.emotionZh || ""); }
      if (s.event) o.event = String(s.event);
      return o;
    }).filter((s) => s.text) : [];
    const emotions = (j.emotions && typeof j.emotions === "object") ? j.emotions : {};
    const events = (j.events && typeof j.events === "object") ? j.events : {};
    return {
      ok: true,
      source: "asr",
      engine: j.engine || "whisper",
      model: j.model || "whisper",
      text: String(j.text || "").trim(),
      segments: segs,
      lang: j.lang || "",
      audioSec: Number(j.audioSec) || 0,
      rtf: Number(j.rtf) || 0,
      emotions,
      emotionsZh: (j.emotionsZh && typeof j.emotionsZh === "object") ? j.emotionsZh : {},
      dominant: j.dominant || "",
      dominantZh: j.dominantZh || "",
      events,
      eventsZh: (j.eventsZh && typeof j.eventsZh === "object") ? j.eventsZh : {},
      credits: j.credits || "",
      pinyin: String(j.pinyin || ""),
      readAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: "调不到本地识别服务（" + ep + "）：" + errText(e) };
  }
}

/* ---------------- 台词回顾：让大模型看一遍上下文 ---------------- */

/** 提示词：把"能改什么"和"绝对不能改什么"都写死。
 *  这里每一条都是踩过的坑 —— 模型天然爱润色、爱合并短句、爱把口语改成书面语，
 *  而下游 Agent 会把改过的句子当事实引用。
 *
 *  输出**分两档**（2026-11-02 实测后改的）：
 *  第一版写的是"不确定就不改、宁可留错"，结果 105 段里只改了 2 处，
 *  `L→iOS`、`屠商→图商` 之外那些明显错字全被"保守"吞掉了。
 *  现在的做法是：有把握的进 fixes（直接替换），没把握但可疑的进 suspects
 *  （**只标注、不替换**，写进 index.md 让人和 Agent 自己判断）。
 *  这样既不用承担改错的风险，也不用把"我怀疑但不敢动"的信息丢掉。 */
const REVIEW_SYSTEM = [
  "你是中文语音转写校对员。输入是一段带全局序号和时间戳的机器转写（离线语音识别结果）。",
  "它常见的错误只有四类：同音字、专有名词（人名/产品名/机构名/术语）、数字与单位、连读造成的断句错误。",
  "",
  "如果输入里给了「热词表」，那是本片可能出现的专有名词的**权威写法**（来自标题/标签/简介）。",
  "转写里与热词读音相同或相近的字，优先按热词的写法纠正——",
  "例如热词有「数组」而转写是「宿组」，这就是有依据的 fix，不用再疑虑；",
  "但热词没出现的段落照旧按两档处理，不许因为想匹配热词而硬改。",
  "",
  "请把你发现的疑点分成两档输出：",
  "- fixes：你有把握的错，给出改好的整句。下游会**直接替换**。",
  "- suspects：你觉得可疑但没把握的，给出你认为可能的写法，并说明疑点。下游**只标注、不替换**。",
  "宁可把不确定的放进 suspects，也不要因为它不确定就整条不提——",
  "「明显不成词的字」（例如「屠商」「自检专业」「碰着」）这类必须至少进 suspects。",
  "",
  "硬规则：",
  "1. 不许润色、不许改写语气、不许增删内容、不许把口语改成书面语、不许补全没说完的话。",
  "2. 不许合并或拆分句子，不许改序号，不许改动情绪标签。",
  /* 实测教训：模型会把「L」猜成「安卓」（因为上文提到安卓），把一个明显的 iOS 误识
     改成另一个错。单字/单字母的替换是风险最高的一类，必须降到 suspects。 */
  "3. 单个字或单个字母的替换（例如「L」→ 某个产品名）风险最高："
    + "除非上下文里有确切的写法依据，否则一律放进 suspects，不要放进 fixes。",
  "4. 只改标点符号、空格、简繁体的「改动」不算校对，不要输出。",
  "5. 没问题的句子两档都不要出现。",
  "6. 每行输出**一个** JSON 对象，逐行排列，**不要**在外层套数组、不要 markdown 代码块、",
  "   不要任何解释或推理文字（尤其不要先写思考过程）。三种行：",
  "   - 有把握的错： {\"kind\":\"fix\",\"i\":序号,\"text\":\"改好的整句\"}",
  "   - 可疑但没把握： {\"kind\":\"suspect\",\"i\":序号,\"text\":\"可能的写法\",\"why\":\"疑点\"}",
  "   - 收尾一行（可选）： {\"terms\":[\"纠正后的专有名词\"],\"notes\":\"一句话\"}",
  "   一句都不用改时，只输出收尾那一行 {\"terms\":[],\"notes\":\"未发现问题\"}。第一行就必须是 {。",
].join("\n");

/** 取当前可用的对话模型；没配就返回 null（那就跳过回顾，不算错）。 */
function modelSlot() {
  try {
    const s = ctx.model();
    if (!s || !s.baseUrl || !s.model) return null;
    return s;
  } catch { return null; }
}

/** 从模型回复里抠 JSON：纯 JSON / ```json 围栏 / 前后带废话 / 尾逗号，四种都要能吃下。 */
function extractJson(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const cands = [body];
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a >= 0 && b > a) cands.push(body.slice(a, b + 1));
  const c = body.indexOf("["), d = body.lastIndexOf("]");
  if (c >= 0 && d > c) cands.push(body.slice(c, d + 1));
  for (const s of cands) {
    for (const t of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
      try { return JSON.parse(t); } catch { /* 试下一个 */ }
    }
  }
  return null;
}

/** 解析 JSONL：一行一个 JSON 对象，坏一行只丢一行，不会毁掉整批。
 *  这是针对 thinking 类模型把推理过程混进回复、整批 JSON 解析失败的补丁 ——
 *  上一版（单个大 JSON）一次报废就丢 30 段，现在最多丢那一行。
 *  同时兼容旧版"单个大 JSON 对象/数组"口径：解析不到任何行就回退到 extractJson。 */
function extractJsonl(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const out = { fixes: [], suspects: [], terms: [], notes: "", parsed: false };
  let any = false;
  for (let line of body.split(/\r?\n/)) {
    line = line.trim().replace(/,$/, "").trim();
    if (!line || line === "[" || line === "]") continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    any = true;
    /* 一个对象既可能是单行条目（{kind, i, text}），也可能是旧版容器
       （{fixes:[...], suspects:[...], terms:[...], notes}）——后者整行出现时按容器拆。 */
    if (obj.fixes || obj.lines || obj.suspects || Array.isArray(obj.terms) || obj.notes !== undefined) {
      pullContainer(obj, out, /* fromJsonl */ true);
    } else if (Array.isArray(obj)) {
      for (const it of obj) if (it && typeof it === "object") routeLine(it, out, false);
    } else {
      routeLine(obj, out, false);
    }
  }
  if (!any) {
    /* 一行都没解析出来：可能是旧版单个大 JSON（整段就一行），回退。 */
    const j = extractJson(raw);
    if (j) { pullContainer(j, out, /* fromJsonl */ false); out.parsed = true; }
  } else {
    out.parsed = true;         // 至少有一行解析成功 = 这一批有效（包括"只有 meta 行"的空结果）
  }
  return out;
}

/** 从容器对象里抽取 fixes / suspects / terms / notes。fixes 与 lines 都当 fix 处理。 */
function pullContainer(obj, out, fromJsonl) {
  const fixes = Array.isArray(obj.fixes) ? obj.fixes
    : (Array.isArray(obj.lines) ? obj.lines : []);
  for (const it of fixes) if (it && typeof it === "object") routeLine(it, out, false);
  for (const it of (Array.isArray(obj.suspects) ? obj.suspects : [])) if (it && typeof it === "object") routeLine(it, out, true);
  for (const t of (Array.isArray(obj.terms) ? obj.terms : [])) { const s = String(t || "").trim(); if (s) out.terms.push(s); }
  if (obj.notes) out.notes = String(obj.notes).trim().slice(0, 300);
}

/** 把一行归到 fixes / suspects。forceSuspect=true 表示来自旧版 suspects 数组；
 *  JSONL 下则看显式 kind=suspect 或对象自带 suspect 字段。 */
function routeLine(o, out, forceSuspect) {
  const i = Number(o.i);
  const text = String(o.text || o.fix || o.suspect || "").trim();
  if (!Number.isInteger(i) || !text) return;   // 没有 i/text 的不是条目行（meta 由主循环读），忽略
  const rec = { i, text, why: String(o.why || "").trim() };
  const kind = String(o.kind || "").trim().toLowerCase();
  if (forceSuspect || kind === "suspect" || o.suspect !== undefined) out.suspects.push(rec);
  else out.fixes.push(rec);
}

/** 一次 /chat/completions。走 OpenAI 兼容口径，和「设置 › 视觉」那套槽位完全一致。 */
async function postChat(slot, system, user, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = String(slot.baseUrl).replace(/\/+$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(slot.apiKey ? { Authorization: "Bearer " + slot.apiKey } : {}),
      },
      body: JSON.stringify({
        model: slot.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: 4096,
        temperature: 0,
        /* 厂商私有参数透传（典型：Qwen 的 enable_thinking:false，
           否则回复里先吐一段思考过程，JSON 就被埋了）。 */
        ...(slot.extra && typeof slot.extra === "object" ? slot.extra : {}),
      }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: "HTTP " + res.status + " " + text.slice(0, 160) };
    let j = null;
    try { j = JSON.parse(text); } catch { return { ok: false, error: "接口没回 JSON" }; }
    const content = j && j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content : "";
    return { ok: true, content: typeof content === "string" ? content : "" };
  } catch (e) {
    const msg = errText(e);
    return { ok: false, error: /abort/i.test(msg) ? "超时" : msg.slice(0, 160) };
  } finally { clearTimeout(timer); }
}

/** 改动幅度检查：长度差超过 50%~180%，或公共字比例过低，就当模型在重写而不是在校对。
 *  没有这道闸，一次幻觉就能把一整句正经台词换掉，而且是静默的。 */
function similarEnough(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (!x || !y) return false;
  const lr = y.length / x.length;
  if (lr < 0.5 || lr > 1.8) return false;
  const set = new Set(x.replace(/\s/g, "").split(""));
  const ych = y.replace(/\s/g, "").split("");
  if (!ych.length) return false;
  let hit = 0;
  for (const ch of ych) if (set.has(ch)) hit++;
  return hit / ych.length >= 0.55;
}

/** 只动了标点/空格/简繁？那不属于"四类错误"，一律不采纳。
 *  实测：模型把「做不出来來。」改成「做不出来來.」——句号换成英文点也算一条"修正"，
 *  这种改动既没价值，还会把"改过 3 段"这个数字注水。 */
function onlyPunctDiff(a, b) {
  const norm = (s) => String(s || "").replace(/[\s，。！？、,.!?;；:：""''"'（）()《》…—\-~·]/g, "");
  const x = norm(a), y = norm(b);
  return !!x && x === y;
}

function buildReviewUser(segs, from, to, meta, title, batch, batches, hotwords, pinyin) {
  const L = [];
  L.push("视频标题：" + (title || "（未知）"));
  if (Array.isArray(hotwords) && hotwords.length) {
    L.push("热词表（本片可能出现的专有名词的权威写法）：" + hotwords.slice(0, HOTWORD_MAX).join("、"));
  }
  if (pinyin) {
    L.push("热词读音参考（拼音，仅供辅助判断同音字，仍以热词表写法为准）：" + pinyin);
  }
  if (meta && meta.durationSec) L.push("视频时长：" + fmtClock(meta.durationSec));
  L.push("本批：第 " + batch + "/" + batches + " 批，覆盖全局序号 " + from + " ~ " + (to - 1)
    + "（序号必须原样回填，不要重新编号）");
  L.push("");
  L.push("转写内容（格式：序号 | 起止时间 | 文字）：");
  for (let i = from; i < to; i++) {
    const s = segs[i];
    L.push(i + " | " + fmtClock(s.start) + "-" + fmtClock(s.end) + " | " + s.text);
  }
  L.push("");
  L.push("每行一个 JSON 对象，不要数组、不要代码块（thinking 类模型尤其注意：直接给 JSON，别先写推理）：");
  L.push('  {"kind":"fix","i":序号,"text":"有把握改好的整句"}');
  L.push('  {"kind":"suspect","i":序号,"text":"疑似应该是的样子","why":"疑点简述"}');
  L.push('  {"terms":["专有名词"],"notes":"一句话"}   ← 收尾可选');
  L.push("都没问题就只输出 {\"terms\":[],\"notes\":\"未发现问题\"}。序号必须原样回填。");
  return L.join("\n");
}

/* ---------------- 情绪复核：纠正"反问被判成生气" ----------------
 * 为什么必须交给语言模型：实测（docs/_sv_emo_context_probe.py，2026-11-02）
 * 把"你愿不愿意为了这么一个免费啊？"单独切、带前一句、带前后文各跑一遍，
 * ANGRY 标签**一直在**——因为识别是逐段判的，喂多少上下文它都会切回 2 秒一段。
 * 也就是说这不是"信息不够"，是声学特征本身就像：语速偏快 + 收尾重音抬高。
 * 而"这是生气还是在引导观众一起想"，只有语义能判。
 *
 * 同一部片子里 7 个疑问句，5 个判对了 —— 所以不能一条规则把疑问句全降级，
 * 只能把**已经被标成非平静的那几段**（通常个位数）挑出来单独问一次。
 */
const EMO_REVIEW_MAX = 12;            // 一次最多复核几段；再多说明这片子确实是情绪片，不缺样本
const TONE_SET = new Set(["anger", "emphasis", "rhetoric", "calm"]);
const TONE_ZH = { anger: "", emphasis: "强调", rhetoric: "反问", calm: "", other: "" };

const EMO_SYSTEM = [
  "你是中文语音语气标注员。用户给你几段带上下文的台词，每段都已经有一个机器判定的情绪标签。",
  "机器只看声音，分不清「生气」和「反问、强调、引导观众思考」——这三者的声学特征很像（语速偏快、收尾重音抬高）。",
  "",
  "请只依据台词内容与上下文，为每一段重新判定说话人的语气，四选一：",
  "- anger：真的在表达不满、指责、愤怒（有明确的责怪对象或攻击性措辞）",
  "- emphasis：只是在强调、加重语气、制造戏剧感（不含攻击性）",
  "- rhetoric：反问、设问、引导观众一起想（常见于解说的「你愿不愿意…？」「怎么办呢？」）",
  "- calm：正常陈述，语气平稳",
  "判不准就选 calm。不要因为句末有问号就判成 anger。",
  "只输出 JSON，不要 markdown 代码块，不要解释：",
  '{"items":[{"i":序号,"tone":"anger|emphasis|rhetoric|calm","why":"不超过12字的理由"}]}',
].join("\n");

/** 挑出需要复核的段：只挑"已经被标成非平静"的，其余不动。 */
function toneCandidates(transcript) {
  const segs = (transcript && transcript.ok && Array.isArray(transcript.segments)) ? transcript.segments : [];
  const picks = [];
  for (let i = 0; i < segs.length; i++) {
    const e = segs[i] && segs[i].emotion;
    if (e && e !== "NEUTRAL") picks.push(i);
  }
  return picks;
}

function buildEmoToneUser(segs, picks, meta, title, hotwords, pinyin) {
  const L = [];
  L.push("视频标题：" + (title || "（未知）"));
  if (Array.isArray(hotwords) && hotwords.length) {
    L.push("热词表（本片专有名词的权威写法，判断语气时可参考，但语气判定只看内容与上下文）："
      + hotwords.slice(0, HOTWORD_MAX).join("、"));
  }
  if (pinyin) {
    L.push("热词读音参考（拼音）：" + pinyin);
  }
  L.push("下面每段都附了它的前一句和后一句作为上下文（上下文只供理解，不参与判定）。");
  L.push("");
  for (const i of picks) {
    const s = segs[i];
    const prev = segs[i - 1] ? segs[i - 1].text : "";
    const next = segs[i + 1] ? segs[i + 1].text : "";
    L.push("### 序号 " + i + "（机器判定：" + (s.emotionZh || s.emotion) + "）");
    if (prev) L.push("前：" + String(prev).slice(0, 120));
    L.push("本句：" + s.text);
    if (next) L.push("后：" + String(next).slice(0, 120));
    L.push("");
  }
  L.push('只输出 JSON：{"items":[{"i":序号,"tone":"anger|emphasis|rhetoric|calm","why":"不超过12字的理由"}]}');
  return L.join("\n");
}

/** 情绪复核。只改"非平静"那几段的标签，并把 tone 记在段上供展示层用。
 *  失败一律不改动 —— 原有的标签虽然可能是错的，但"篡改后无法回溯"更糟。 */
async function reviewEmotions(transcript, meta, title, slot, hotwords) {
  const segs = transcript && transcript.segments;
  const out = {
    on: false, ok: false, n: 0, changed: 0, partial: false,
    tones: {}, ms: 0, error: "",
  };
  const picks = toneCandidates(transcript);
  if (!picks.length) return out;                 // 全片没有非平静段，没什么可复核
  out.on = true;
  out.n = picks.length;
  const use = picks.slice(0, EMO_REVIEW_MAX);
  out.partial = use.length < picks.length;
  const t0 = Date.now();
  const r = await postChat(slot, EMO_SYSTEM, buildEmoToneUser(segs, use, meta, title, hotwords, transcript.pinyin || ""), REVIEW_BATCH_MS);
  out.ms = Date.now() - t0;
  if (!r.ok) { out.error = r.error; return out; }
  const j = extractJson(r.content);
  const items = Array.isArray(j && j.items) ? j.items : (Array.isArray(j) ? j : []);
  if (!items.length) { out.error = "复核回复里没有 items"; return out; }
  for (const it of items) {
    const i = Number(it && it.i);
    if (!Number.isInteger(i) || use.indexOf(i) < 0) continue;
    const tone = String((it && it.tone) || "").trim().toLowerCase();
    if (!TONE_SET.has(tone)) continue;
    const seg = segs[i];
    if (!seg) continue;
    seg.tone = tone;                             // 展示层优先用它
    seg.toneWhy = String((it && it.why) || "").trim().slice(0, 24);
    out.tones[tone] = (out.tones[tone] || 0) + 1;
    /* 机器说生气、模型也说是生气：标签成立，转成"已确认"。
       模型说 emphasis/rhetoric/calm：标签撤销，改由 tone 展示。 */
    if (tone === "anger") {
      seg.emotionConfirmed = true;
    } else {
      seg.emotionKept = seg.emotion;              // 保留机器原判，便于回溯
      seg.emotion = "";
      seg.emotionZh = "";
    }
    out.changed++;
  }
  out.ok = out.changed > 0;
  return out;
}

/** 复核后重算情绪计数：不重算的话，index 的汇总会跟逐段标签对不上。 */
function recountEmotions(transcript) {
  const segs = (transcript && transcript.segments) || [];
  const emo = {}, tone = {};
  for (const s of segs) {
    if (s.emotion) emo[s.emotion] = (emo[s.emotion] || 0) + 1;
    /* 语气按**中文名**计数：这份数据是给人读的（index.md 直接拼字符串），
       留着 "rhetoric" 这种内部键名会在界面上露出来。anger/calm 不计数 ——
       前者是"情绪成立"，后者是"没有语气"，都不算"另有语气"。 */
    const zh = TONE_ZH[s.tone];
    if (zh) tone[zh] = (tone[zh] || 0) + 1;
  }
  transcript.emotions = emo;
  transcript.emotionsZh = {};
  for (const [k, v] of Object.entries(emo)) transcript.emotionsZh[EMOTION_ZH_LOCAL[k] || k] = v;
  const top = Object.entries(emo).sort((a, b) => b[1] - a[1])[0];
  transcript.dominant = top ? top[0] : "";
  transcript.dominantZh = top ? (EMOTION_ZH_LOCAL[top[0]] || top[0]) : "";
  transcript.tonesZh = tone;
  return transcript;
}

/* 只给 recount 用的中文名：引擎那边算过一次，这里是复核后本地重算，不跨进程取。 */
const EMOTION_ZH_LOCAL = {
  NEUTRAL: "平静", HAPPY: "高兴", SAD: "低落", ANGRY: "生气",
  FEARFUL: "紧张", DISGUSTED: "厌烦", SURPRISED: "惊讶",
};

/** 回顾全部台词。会**就地改写** transcript.segments[].text，并把原文留在 textRaw。
 *  原则：这一步失败绝不能影响"有台词"这件事 —— 所以它只返回状态，不抛异常。 */
async function reviewTranscript(transcript, meta, title, hotwords) {
  const segs = (transcript && transcript.ok && Array.isArray(transcript.segments)) ? transcript.segments : [];
  const out = {
    on: false, ok: false, model: "", slot: "",
    total: segs.length, covered: 0, changed: 0, suspects: 0, batches: 0,
    calls: 0, failed: 0,
    terms: [], notes: "", partial: false, ms: 0, error: "",
    emotion: null,
    at: new Date().toISOString(),
  };
  if (!segs.length) { out.error = "没有分段（识别服务没回 segments），无从回顾"; return out; }
  const slot = modelSlot();
  if (!slot) { out.error = "没配置对话模型（设置 › 视觉 › 主力/备选）"; return out; }
  out.on = true;
  out.model = slot.model;
  out.slot = slot.slot || "";

  const started = Date.now();
  const batches = Math.min(REVIEW_MAX_BATCHES, Math.ceil(segs.length / REVIEW_BATCH_LINES));
  out.partial = batches * REVIEW_BATCH_LINES < segs.length;
  const terms = new Set();
  const notes = [];

  for (let b = 0; b < batches; b++) {
    if (Date.now() - started > REVIEW_TOTAL_MS) { out.partial = true; notes.push("总时长到上限，后续批次跳过"); break; }
    const from = b * REVIEW_BATCH_LINES;
    const to = Math.min(segs.length, from + REVIEW_BATCH_LINES);
    out.batches++;
    /* 一批最多试两次：第二轮多一句"上次没有可解析的 JSON 行"的提醒。
       JSONL 下即便部分行失败也能解析其余行，所以重试只在"一行都没解析出来"时触发 ——
       这通常意味着模型吐了纯推理过程或空回复，再逼一次往往能救回整批。 */
    let j = null, lastErr = "";
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      const user = buildReviewUser(segs, from, to, meta, title, b + 1, batches, hotwords, transcript.pinyin || "")
        + (attempt
          ? "\n\n注意：你上一次的回复里一行可解析的 JSON 都没有。这一次每行输出一个 JSON 对象，"
            + "不要写推理过程、不要代码块，第一行就必须是 {。"
          : "");
      const r = await postChat(slot, REVIEW_SYSTEM, user, REVIEW_BATCH_MS);
      out.calls++;
      if (!r.ok) {
        lastErr = r.error;
        /* 鉴权/参数类错误重试无意义，直接判这一批失败 */
        if (/40[134]|401|403|404/.test(r.error)) break;
        continue;
      }
      const parsed = extractJsonl(r.content);
      /* parsed.parsed = 至少解析出一行合法 JSON（含"只有 meta 行"的空结果）。
         完全垃圾才重试，避免把"模型说本批没问题"误判成失败。 */
      if (!parsed.parsed) { lastErr = "回复里没有可解析的 JSON 行"; continue; }
      j = parsed;
    }
    if (!j) {
      /* 第一批就废，基本等于配置问题（地址/模型名/Key/限流），不必继续；
         中途失败只作废这一批，前面已经改好的保留。 */
      if (b === 0) { out.error = lastErr || "第一批失败"; break; }
      out.failed += (to - from);
      notes.push("第 " + (b + 1) + " 批失败：" + lastErr);
      continue;
    }
    /* 兼容两种口径：新版给 fixes/suspects，旧版（以及某些模型擅自改字段名）给 lines。
       lines 一律当 fixes —— 它本来就是"模型认为该改的"。 */
    const fixes = Array.isArray(j.fixes) ? j.fixes : (Array.isArray(j.lines) ? j.lines : (Array.isArray(j) ? j : []));
    for (const item of fixes) {
      const i = Number(item && item.i);
      const text = String((item && item.text) || "").trim();
      /* 序号越界一律丢弃：模型编序号是常事，越界的改动无法核对归属。 */
      if (!Number.isInteger(i) || i < from || i >= to || !text) continue;
      const seg = segs[i];
      if (!seg || seg.text === text || seg.textRaw) continue;   // 已改过的不再动（也防模型重复输出覆盖真原文）
      if (onlyPunctDiff(seg.text, text)) continue;
      if (!similarEnough(seg.text, text)) continue;
      seg.textRaw = seg.text;
      seg.text = text;
      delete seg.suspect;            // 已经被采纳的改动，没必要再标"疑似"
      out.changed++;
    }
    /* suspects 只标注、绝不改 text：它们是"我怀疑但不敢动"的，改错了没人能发现。
       同样要过幅度闸 —— 重写型的猜测不配当线索。 */
    for (const item of (Array.isArray(j.suspects) ? j.suspects : [])) {
      const i = Number(item && item.i);
      const text = String((item && item.text) || "").trim();
      if (!Number.isInteger(i) || i < from || i >= to || !text) continue;
      const seg = segs[i];
      if (!seg || seg.text === text || seg.textRaw || seg.suspect) continue;   // 已改过/已标过的不动（防模型重复输出）
      if (onlyPunctDiff(seg.text, text)) continue;
      if (!similarEnough(seg.text, text)) continue;
      seg.suspect = {
        text,
        why: String((item && item.why) || "").trim().slice(0, 40),
      };
      out.suspects++;
    }
    for (const t of (Array.isArray(j.terms) ? j.terms : [])) {
      const s = String(t || "").trim();
      if (s) terms.add(s);
    }
    const n = String(j.notes || "").trim();
    if (n) notes.push(n);
    /* 只有**解析成功**的批次才算回顾过。以前这里写 out.covered = to，
       结果 4 批里废了 2 批，摘要仍写"回顾了 105/105 段"——谎报覆盖面。 */
    out.covered += (to - from);
  }

  out.terms = [...terms].slice(0, 20);
  out.notes = notes.join("；").slice(0, 300);
  out.ok = out.batches > 0 && !out.error;
  if (out.ok) {
    /* 情绪复核是**第二次独立调用**：它看的不是"字对不对"，而是"这句到底是不是在生气"。
       台词校对成功、情绪复核失败，是完全可以接受的状态 —— 两者互不牵连。 */
    const er = await reviewEmotions(transcript, meta, title, slot, hotwords);
    out.emotion = er;
    if (er.ok) recountEmotions(transcript);
    transcript.review = out;
  }
  out.ms = Date.now() - started;
  return out;
}

/** 一句话概括回顾结果；没跑或失败就返回空串（调用方不写这一行）。 */
function reviewSummary(transcript) {
  const rv = transcript && transcript.review;
  if (!rv || !rv.ok) return "";
  const bits = ["用 " + (rv.model || "对话模型") + " 回顾了 "
    + (rv.covered || 0) + "/" + (rv.total || 0) + " 段"];
  bits.push(rv.changed ? "改动 " + rv.changed + " 段" : "没有必改的");
  if (rv.suspects) bits.push("另标出 " + rv.suspects + " 处疑似（未替换，见下）");
  if (rv.failed) bits.push("有 " + rv.failed + " 段没回顾成功（限流或回复不是 JSON）");
  if (rv.partial) bits.push("超出预算的段落保持原样");
  if (rv.terms && rv.terms.length) bits.push("校对出的专名：" + rv.terms.slice(0, 8).join("、"));
  return bits.join("，") + "。只校正同音字/专名/数字/断句，不改内容与语气。";
}

function buildIndex({ job, meta, frames, interval, transcript, origin }) {
  const L = [];
  L.push("# " + (job.title || job.key));
  L.push("");
  L.push("- 来源：" + origin);
  L.push("- 时长：" + fmtClock(meta.durationSec) + " · " + meta.width + "×" + meta.height + " · " + (meta.fps || 0) + "fps · " + meta.videoCodec);
  if (meta.audioSeparate) L.push("- 音轨：独立音频流（DASH 音视频分离，画面文件本身不含声音）");
  const segN = (transcript && transcript.ok && transcript.segments) ? transcript.segments.length : 0;
  L.push("- 台词：" + (transcript && transcript.ok
    ? (segN ? "有（" + segN + " 段带时间戳，本机离线转写）" : "有（只有全文，识别服务没回分段）")
    : (meta.hasAudio ? "未转写（本地识别服务没跑）" : "无音轨（源片没有声音，或录制时音频来源设成了「不录音频」）")));
  /* 情绪只有 SenseVoice 那条引擎给；whisper 给空对象。没有就不写这一行 ——
     写了"情绪：无"会让人以为引擎跑过但没测出情绪。 */
  const emoLine = emoSummary(transcript);
  if (emoLine) L.push("- 情绪：" + emoLine);
  /* 回顾是"附加质量层"：没跑、失败、或一句都不用改，都不写这一行 ——
     写了会让人以为改过，其实只是没动。 */
  const rvLine = reviewSummary(transcript);
  if (rvLine) {
    L.push("- 台词纠错：" + rvLine
      + ((transcript.review && transcript.review.changed)
        ? "改动前的原文留在 transcript.json 的 segments[].textRaw 里，可回溯。" : ""));
  }
  /* 疑似误识单独一段：**没有替换**，所以必须让人看见"原文还在、只是可疑"。
     这是两档输出的第二档 —— 没有它，模型那些"不敢改"的判断就白费了。 */
  const sus = (transcript && transcript.segments ? transcript.segments : [])
    .map((s, i) => (s && s.suspect ? { i, s } : null)).filter(Boolean);
  if (sus.length) {
    L.push("- 疑似误识：" + sus.length + " 处 **未替换**（模型不确定，仅供你判断，别当结论直接引用）");
    for (const o of sus.slice(0, 10)) {
      L.push("  - " + fmtClock(o.s.start) + " 「" + o.s.text + "」 可能应是「" + o.s.suspect.text + "」"
        + (o.s.suspect.why ? "（" + o.s.suspect.why + "）" : ""));
    }
    if (sus.length > 10) {
      L.push("  - ……另有 " + (sus.length - 10) + " 处，完整清单见 transcript.json 的 segments[].suspect");
    }
  }
  L.push("- 截图：" + frames.length + " 张，每 " + interval + " 秒一张，最长边 " + FRAME_WIDTH + "px");
  L.push("");
  L.push("## 怎么用这些产物");
  L.push("");
  L.push("1. **先读 `timeline.md`** —— 它按时间顺序把「台词」和「对应截图」放在一起，绝大多数问题读它就能答。");
  L.push("2. 需要确认画面时再看 `frames/fNNNNN.jpg`，文件名里的序号与 timeline 里的一致。");
  L.push("3. 数字都对不上的时候，回到 `meta.json` 查原始探底值。");
  if (emoLine) {
    L.push("4. **情绪是模型对声音的判断，不是事实**。语气、录音质量、方言都会让它出错；"
      + "尤其**反问句、强调句容易被判成「生气」**（实测：解说里的「你愿不愿意…？」「怎么办呢？」就中过）。"
      + "标成「语气偏重 / 反问 / 强调」的段说明证据不足或已按上下文改判，别当情绪结论；"
      + "和画面表情、台词内容矛盾时**以画面和台词为准**，可以把矛盾本身讲出来。");
  }
  L.push("");
  L.push("> 截图是解码后的原始画面，没有做任何美化或裁剪。画面方向以源文件为准：控制台自己录的片从 1.4.5 起已修正上下颠倒，旧版本留下的片子会是倒的（那是文件本身的问题，不是抽帧）。");
  return L.join("\n") + "\n";
}

/** 情绪分布视图：把「够得上证据的标签」和「孤立的、证据不足的标签」分开。
 *
 *  为什么需要这个门槛：实测这部纪录片 105 段里只有 2 段非平静，而这 2 段恰好
 *  都是反问句被声学判成了生气。也就是说**信噪比最差的位置正是唯一有信息量的位置**，
 *  "2/105 准确"这种算法是自欺。所以这里按"同一种情绪 ≥3 段且 ≥10%"才允许点名，
 *  低于门槛的在线性文本里降级成「语气偏重」——不点名，也就不会替模型编结论。
 */
function emotionView(transcript) {
  const segs = (transcript && transcript.ok && Array.isArray(transcript.segments)) ? transcript.segments : [];
  const total = segs.length;
  const counts = {};
  let neutral = 0;
  for (const s of segs) {
    if (!s || !s.emotion || s.emotion === "NEUTRAL") { neutral++; continue; }
    counts[s.emotion] = (counts[s.emotion] || 0) + 1;
  }
  const soften = new Set();
  for (const [k, n] of Object.entries(counts)) {
    if (n < 3 || n / Math.max(1, total) < 0.10) soften.add(k);
  }
  return {
    total, neutral, nonNeutral: total - neutral, counts, soften,
    tones: (transcript && transcript.tonesZh) || {},
  };
}

/** 一句话概括情绪分布；没有信息量就返回空串（调用方不写这一行）。
 *  全片平静时**故意不写** —— "情绪：平静"对解说类视频恒为真，是废话。 */
function emoSummary(transcript) {
  if (!transcript || !transcript.ok) return "";
  const v = emotionView(transcript);
  const zh = EMOTION_ZH_LOCAL;
  const engine = transcript.engine === "sensevoice" ? "SenseVoice" : "Whisper";
  const er = transcript.review && transcript.review.emotion;
  const toneTxt = (er && er.ok && Object.keys(v.tones).length)
    ? "；上下文复核后另有语气：" + Object.entries(v.tones).map(([k, n]) => k + " " + n + " 段").join("、")
      + "（这是语气不是情绪，见 timeline）"
    : "";
  const evTxt = transcript.eventsZh && Object.keys(transcript.eventsZh).length
    ? "；声学事件：" + Object.keys(transcript.eventsZh).map((k) => k + " " + transcript.eventsZh[k]).join("、")
    : "";

  const keys = Object.keys(v.counts);
  if (!keys.length) {
    /* 全片平静：只在复核判出了语气时才写一行，否则整行省略。 */
    if (toneTxt) return "整体语气平稳" + toneTxt + "。引擎 " + engine;
    return "";
  }
  const named = keys.filter((k) => !v.soften.has(k)).sort((a, b) => v.counts[b] - v.counts[a]);
  const softN = keys.filter((k) => v.soften.has(k)).reduce((a, k) => a + v.counts[k], 0);
  if (!named.length) {
    return "情绪整体平稳，其中 " + softN + " 段语气偏重未点名"
      + "（模型判断，可能是反问或强调，不作结论）" + toneTxt
      + "。按句判断，仅供参考，不是事实。引擎 " + engine;
  }
  const parts = named.map((k) => (zh[k] || k) + " " + v.counts[k] + " 段");
  const head = "整体以「" + (zh[named[0]] || named[0]) + "」为主";
  const softTxt = softN ? "；另有 " + softN + " 段语气偏重未点名" : "";
  return head + "（" + parts.join(" / ") + softTxt + "）" + evTxt + toneTxt
    + "。按句判断，仅供参考，不是事实。引擎 " + engine;
}

/** 单段该贴什么标签：复核过的语气优先于机器的情绪标签。 */
function segTag(s, v) {
  if (!s) return "";
  if (s.tone && TONE_ZH[s.tone]) return TONE_ZH[s.tone];
  if (!s.emotionZh) return "";
  if (v && v.soften.has(s.emotion)) return "语气偏重";
  return s.emotionZh;
}

function buildTimeline({ meta, frames, transcript }) {
  const L = [];
  const segs = (transcript && transcript.ok && transcript.segments) ? transcript.segments : [];
  /* 顶部一行说明"这些字是被校对过的"。Agent 主要读这个文件，
     它需要知道台词不是原始转写 —— 否则会把模型改错的字当原话引用。 */
  const rv = transcript && transcript.review;
  const emoRv = rv && rv.emotion;
  if (rv && rv.ok) {
    L.push("> 台词已由 " + (rv.model || "对话模型") + " 回顾过（改动 " + (rv.changed || 0)
      + " 段，只改同音字/专名/数字/断句，不改内容与语气）"
      + (emoRv && emoRv.ok ? "；其中 " + (emoRv.changed || 0) + " 段语气经上下文复核" : "")
      + "。");
    L.push("");
  }
  const v = emotionView(transcript);
  const susN = segs.filter((s) => s && s.suspect).length;
  if (susN) {
    L.push("> 另有 " + susN + " 处疑似误识只标注未替换，清单在 index.md（引用原话前可先看一眼）。");
    L.push("");
  }
  const step = frames.length > 1 ? (frames[1].t - frames[0].t) : 5;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const from = f.t;
    const to = Math.min(Number(meta.durationSec) || from + step, from + step);
    L.push("## " + fmtClock(from) + " - " + fmtClock(to));
    const said = segs.filter((s) => s.end > from && s.start < to);
    if (said.length) {
      /* 语气标签贴在台词后面而不是单独一行：读的时候"谁在哪一刻什么语气"是一体的，
         拆成两行反而要在时间轴上对两次。同一格里有多种标签时全列出来，不取平均。 */
      const tags = [];
      for (const s of said) {
        const t = segTag(s, v);
        if (t && tags.indexOf(t) < 0) tags.push(t);
      }
      L.push("台词" + (tags.length ? "〔" + tags.join("/") + "〕" : "") + "：" + said.map((s) => s.text).join(" "));
    }
    L.push("帧：`frames/" + f.file + "`");
    L.push("");
  }
  if (!frames.length) L.push("（没有截出任何帧）");
  return L.join("\n") + "\n";
}

/** 给派发任务用的引用块：把产物目录里"该读哪几个文件"写进任务文本。 */
function promptBlock(result) {
  if (!result || !result.ok) return "";
  const lines = ["视频解析产物（本地已解析好，直接读文件，不要再去下载或猜测内容）："];
  lines.push("- 索引：" + result.index);
  lines.push("- 时间线：" + path.join(result.dir, "timeline.md") + " ← 优先读这个");
  if (result.frames) lines.push("- 截图：" + path.join(result.dir, "frames") + "/（" + result.frames + " 张）");
  if (result.hasTranscript) lines.push("- 台词全文：" + path.join(result.dir, "transcript.json"));
  else lines.push("- 台词：无（本机没跑语音识别，只有画面）");
  /* 情绪是"额外一层"，不是每条片子都有（取决于本地识别引擎）。
     在这里说清楚它的性质，Agent 才不会把它当结论直接复述。 */
  if (result.hasTranscript) {
    lines.push("- 情绪/声学事件：在同目录 transcript.json 的 emotions / segments[].emotion 里"
      + "（timeline.md 已经把语气标签贴在台词后面）。这是模型对**声音**的判断，可能错；"
      + "**反问句和强调句特别容易被判成生气**，标成「语气偏重/反问/强调」的段就是证据不足或已按上下文改判的人。"
      + "和画面表情、台词内容矛盾时以画面和台词为准，矛盾本身可以作为线索讲出来。");
  }
  /* 校对过就要说清楚：它是"更好读的转写"，仍然是转写，不是逐字稿底本。 */
  if (result.reviewed) {
    lines.push("- 台词纠错：已用对话模型回顾过一遍（改动 " + (result.reviewChanged || 0)
      + " 段，只校正同音字/专名/数字/断句）。它是转写，不是原话逐字稿；"
      + "需要核对原文时看 transcript.json 里的 segments[].textRaw。");
  }
  /* 疑似项必须单独交代：这些字**没有被替换**，只是被点名。
     Agent 拿它们当"可能听错的地方"，而不是当结论。 */
  if (result.suspects) {
    lines.push("- 疑似误识：" + result.suspects + " 处（模型不确定，**原文未替换**），"
      + "index.md 里逐条列了「原文 → 可能应是」，引用原话前建议先看一眼；"
      + "如果你判断某条成立，直接用你的判断说，不要反过来把疑似写法当事实。");
  }
  return lines.join("\n");
}

module.exports = {
  init,
  runtimeStatus,
  installRuntime,
  status,
  run,
  promptBlock,
  /* 诊断用，不接 IPC */
  _paths: { rtPython, asrPython },
  _compose: { buildIndex, buildTimeline, emoSummary, promptBlock, reviewSummary, emotionView, segTag },
  _review: {
    extractJson, extractJsonl, similarEnough, onlyPunctDiff, buildReviewUser, modelSlot, reviewTranscript,
    reviewEmotions, toneCandidates, recountEmotions,
    wordsFromText, collectHotwords,
  },
};
