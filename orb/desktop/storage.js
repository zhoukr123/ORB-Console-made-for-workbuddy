/* ---------------- 长期文件存储管理 ----------------
 * 录屏 / 会话历史 / 截图这三类文件将来会越攒越多，不能继续散在项目根目录下：
 *   ① 打包后 __dirname 在只读的 app.asar 里（打包态写盘 = EPERM，这是老坑）；
 *   ② 用户可能想把大文件放到数据盘 / NAS，而不是系统盘；
 *   ③ 「换位置」如果不做搬迁，之前录的东西就找不回来了。
 * 所以这里统一一层：所有长期读写都问 pathOf() 要目录，根目录只有一个来源
 * （用户设的 state.storageRoot，没设就回退 DATA_ROOT）。
 *
 * DATA_ROOT 由 main.js 算好后注入进来：开发态它天然等于项目根，
 * 打包态自动落到 %APPDATA%/ORB 控制台 —— 本模块因此不需要知道任何绝对路径。
 */

const fs = require("node:fs");
const path = require("node:path");
const { shell } = require("electron");

/* 长期子目录。名字固定，是为了搬迁时只要搬这几个目录，
   不用逐个辨认散落的文件；也方便用户在资源管理器里一眼看懂。

   vidx（看视频）：视频/音频解析产物的落盘位置，一个来源一个子目录，
   内含 meta/transcript/timeline/frames/media 等。它和 recordings 的区别是
   —— recordings 存"原始录制文件"，vidx 存"解析后的产物"。 */
const SUBDIRS = Object.freeze({
  recordings: "recordings",
  history: "history",
  screenshots: "screenshots",
  vidx: "vidx",
});

/* 临时目录：录屏分片先写到 recordings/.tmp，合并成功才 rename 进 recordings。
 * 必须挂在 recordings 里面而不是系统 temp —— 同卷 rename 是原子的而且瞬时，
 * 跨卷会退化成「复制几百 MB 再删除」，用户会明显感到卡顿，
 * 中断时还可能留下半个文件。 */
const TMP_DIRNAME = ".tmp";

/* 单次统计 / 搬迁的条目上限。存了几十万文件时不该把主进程钉在这儿几十秒，
   超了就截断（这俩接口本来只是给设置面板显示个大概用量）。 */
const SCAN_LIMIT = 20000;
const MIGRATE_LIMIT = 20000;
const MAX_DEPTH = 24;

/* 宿主上下文（由 main.js 注入）。
 * 为什么不直接 require("../main")：那会形成 require 环，两边都拿到半成品。
 * 由 main 在启动早期注入 dataRoot / state 访问器，本模块只依赖这几个契约。 */
let ctx = {
  dataRoot: "",
  getState: () => ({}),
  setState: () => {},
  log: () => {},
};

/**
 * 注入宿主上下文。
 * @param {object} next
 * @param {string} next.dataRoot 默认存储根（main.js 的 DATA_ROOT）
 * @param {() => object} next.getState 读 state
 * @param {(patch: object) => void} next.setState 写 state（main.js 的 saveState）
 * @param {(...args: any[]) => void} [next.log] 日志
 */
function init(next) {
  if (!next || typeof next !== "object") return;
  ctx = {
    dataRoot: typeof next.dataRoot === "string" ? next.dataRoot : ctx.dataRoot,
    getState: typeof next.getState === "function" ? next.getState : ctx.getState,
    setState: typeof next.setState === "function" ? next.setState : ctx.setState,
    log: typeof next.log === "function" ? next.log : ctx.log,
  };
}

function note(...args) {
  try { ctx.log("[storage]", ...args); } catch { /* 日志绝不能反咬调用方 */ }
}

function errText(e) {
  return (e && e.message) ? e.message : String(e);
}

/** 当前生效的存储根：用户设过就用用户的，否则回退 DATA_ROOT。 */
function resolveRoot() {
  const s = ctx.getState() || {};
  const r = s.storageRoot;
  if (typeof r === "string" && r.trim()) return path.resolve(r.trim());
  // 兜底到 cwd 而不是 process.cwd() 之外的东西：DATA_ROOT 照例应该有值，
  // 这里只保证 pathOf() 在任何调用时机都不会返回 undefined。
  return ctx.dataRoot || process.cwd();
}

/**
 * 子目录绝对路径。
 * @param {"recordings"|"history"|"screenshots"|"tmp"} kind
 * @returns {string|null} 未知类型返回 null，让调用方自己决定怎么处理
 */
function pathOf(kind) {
  const root = resolveRoot();
  if (kind === "tmp") return path.join(root, SUBDIRS.recordings, TMP_DIRNAME);
  const name = SUBDIRS[kind];
  if (!name) return null;
  return path.join(root, name);
}

/** child 是否位于 parent 内部（含等于）。用于阻止把存储根选到旧根里面造成自我嵌套。 */
function isInside(parent, child) {
  try {
    const rel = path.relative(parent, child);
    if (rel === "") return true;
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return true;
  } catch {
    return false;
  }
}

/** 逐级向上找到第一个真实存在的祖先：磁盘信息要按存在的那一级去问。 */
function existingAncestor(p) {
  let cur = p;
  for (let i = 0; i < 8; i++) {
    try { if (fs.existsSync(cur)) return cur; } catch { return p; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return p;
}

/**
 * 确保三个子目录（以及 recordings/.tmp）存在。
 * 重复调用安全：recursive:true 对已存在的目录不会报错。
 * @returns {{ok: boolean, root: string, dirs: object, error: string|null}}
 */
function ensureSubdirs() {
  const root = resolveRoot();
  const out = { ok: true, root, dirs: {}, error: null };
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    out.ok = false;
    out.error = "存储根无法创建：" + errText(e);
    note("ensureSubdirs 失败:", out.error);
    return out;
  }
  for (const kind of Object.keys(SUBDIRS)) {
    const dir = pathOf(kind);
    try {
      fs.mkdirSync(dir, { recursive: true });
      out.dirs[kind] = dir;
    } catch (e) {
      out.ok = false;
      if (!out.error) out.error = `${kind} 目录创建失败：` + errText(e);
      out.dirs[kind] = null;
    }
  }
  const tmp = path.join(root, SUBDIRS.recordings, TMP_DIRNAME);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    out.dirs.tmp = tmp;
  } catch (e) {
    // 临时目录建不出来不算致命（录屏用不了而已），但必须告诉上层
    out.dirs.tmp = null;
    if (!out.error) out.error = "临时目录创建失败：" + errText(e);
  }
  return out;
}

/** 递归统计某目录下的文件数与字节数（自身异常不影响整体统计）。 */
function scanDir(dir, depth, budget) {
  const res = { files: 0, bytes: 0, truncated: false };
  if (depth > MAX_DEPTH) return res;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return res;   // 目录不存在 / 无权限：当作空目录处理
  }
  for (const e of entries) {
    if (budget.files >= SCAN_LIMIT) { res.truncated = true; break; }
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const sub = scanDir(full, depth + 1, budget);
        res.files += sub.files;
        res.bytes += sub.bytes;
        if (sub.truncated) res.truncated = true;
      } else if (e.isFile()) {
        res.files += 1;
        res.bytes += fs.statSync(full).size;
      }
    } catch { /* 单个文件 stat 失败（被占用 / 断链）跳过，不拖垮整体 */ }
  }
  return res;
}

/** 只数「一层子目录」（跳过 .tmp 这类点开头的工作目录）。
 *  vidx 目录里一个子目录就是一次解析任务（一个视频/音频来源），
 *  用户关心的是"我分析过几个视频"，不是里面躺着几百个 meta/frame 文件。 */
function countSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

/** 磁盘可用/总容量。statfs 在部分挂载类型上会失败，失败就返回 0（UI 显示「未知」）。 */
function diskSpace(root) {
  try {
    const st = fs.statfsSync(existingAncestor(root));
    const bsize = Number(st.bsize) || 0;
    return {
      free: Number(st.bavail ?? st.bfree ?? 0n) * bsize,
      total: Number(st.blocks ?? 0n) * bsize,
    };
  } catch {
    return { free: 0, total: 0 };
  }
}

/**
 * 各子目录文件数 / 字节数 + 根目录磁盘余量。
 * 给设置面板用：这里每多算一项，用户就少一次自己去资源管理器里数。
 * @returns {{ok: boolean, root: string, isDefault: boolean, rootExists: boolean,
 *            free: number, total: number, dirs: object, error: string|null}}
 */
function stat() {
  const root = resolveRoot();
  const s = ctx.getState() || {};
  const configured = typeof s.storageRoot === "string" && !!s.storageRoot.trim();
  const dirs = {};
  try {
    for (const kind of Object.keys(SUBDIRS)) {
      const dir = pathOf(kind);
      const exists = fs.existsSync(dir);
      const scanRes = scanDir(dir, 0, { files: 0 });
      dirs[kind] = {
        kind,
        path: dir,
        exists,
        files: exists ? scanRes.files : 0,
        /* 面板对「看视频」显示的是 folders（= 解析过的视频个数），不是 files。
           一次解析会产生 meta/transcript/timeline/frames/media 几十上百个文件，
           拿 files 当"视频数"会显示成"274 个文件"，和目录里看到的完全对不上。 */
        folders: exists ? countSubdirs(dir) : 0,
        bytes: exists ? scanRes.bytes : 0,
        truncated: !!scanRes.truncated,
      };
    }
  } catch (e) {
    return { ok: false, root, isDefault: !configured, rootExists: false, free: 0, total: 0, dirs, error: errText(e) };
  }
  const { free, total } = diskSpace(root);
  return {
    ok: true,
    root,
    isDefault: !configured,           // UI 上据此显示「默认位置」还是「自定义」
    rootExists: fs.existsSync(root),  // 拔掉移动硬盘时会是 false，必须让用户看见
    free,
    total,
    dirs,
    error: null,
  };
}

/** 写探针：光有目录不代表能写（只读卷 / 权限被改 / 企业策略都可能让 mkdir 成功而写文件失败）。 */
function probeWritable(dir) {
  const probe = path.join(dir, ".orb-write-test");
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch { /* 已经删不掉了，忽略 */ }
    return errText(e);
  }
}

/**
 * 设置新的存储根。
 * 校验顺序刻意按「越便宜越先」：先看是不是字符串，再看存不存在，
 * 最后才写探针 —— 写探针会真的落一个文件，没必要在明显出错的情况下做。
 * @param {string} dir
 * @returns {{ok: boolean, root: string, prev: string, changed: boolean,
 *            needMigrate: boolean, reason: string|null}}
 */
function setRoot(dir) {
  const cur = resolveRoot();
  const fail = (reason) => ({ ok: false, root: cur, prev: "", changed: false, needMigrate: false, reason });
  if (typeof dir !== "string" || !dir.trim()) return fail("目录为空");

  const target = path.resolve(dir.trim());
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return fail("选择的不是文件夹");
  } catch (e) {
    // 还没存在：帮用户建出来（选了 D:\ORB 这种一级新目录是很常见的）
    try { fs.mkdirSync(target, { recursive: true }); }
    catch (e2) { return fail("目录无法创建：" + errText(e2)); }
  }
  const noWrite = probeWritable(target);
  if (noWrite) return fail("该目录不可写入：" + noWrite);
  // 选到旧根内部会导致 recordings/recordings 这种自我嵌套，搬迁时还会自己拷自己
  if (isInside(cur, target) && cur !== target) return fail("新目录不能位于当前存储目录内部");
  /* 反方向同样要禁：把新根选成当前根的**上级**（比如当前在 D:\ORB\data、新选
     D:\ORB）时，上面那条拦不住（target 不包含在 cur 里），于是 setRoot 成功、
     storageRootPrev 也记下了 —— 但 migrate() 里"旧目录位于新目录内部"的检查会
     把它挡回来，搬迁永远做不成，设置面板从此一直提示"有旧数据待搬迁"。
     两个方向的嵌套校验必须对称，否则就是个死结。 */
  if (isInside(target, cur) && cur !== target) return fail("新目录不能是当前存储目录的上级（搬迁会造成自我嵌套）");

  const prev = cur;
  if (prev === target) {
    // 用户又选了一遍当前目录：不算错误，但也不需要搬迁
    ctx.setState({ storageRoot: target });
    return { ok: true, root: target, prev, changed: false, needMigrate: false, reason: null };
  }
  const needMigrate = hasContent(prev);
  // 旧值必须留着：migrate() 靠它才知道从哪儿搬，用户反悔也能自己找回去
  ctx.setState({ storageRoot: target, storageRootPrev: prev });
  note("setRoot:", prev, "->", target, "needMigrate =", needMigrate);
  return { ok: true, root: target, prev, changed: true, needMigrate, reason: null };
}

/** 旧根里是不是已经有内容：没内容的「搬迁」不值得弹一个提示去烦用户。 */
function hasContent(root) {
  for (const kind of Object.keys(SUBDIRS)) {
    const dir = path.join(root, SUBDIRS[kind]);
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name === TMP_DIRNAME) continue;   // 临时目录不算用户资产
        return true;
      }
    } catch { /* 读不了就当没内容 */ }
  }
  return false;
}

/**
 * 递归拷贝（用于搬迁）。逐条 try/catch —— 单个文件失败不能让整批回滚，
 * 用户宁可看到「搬了 128 个，3 个失败」也不想全盘重来。
 */
function copyTree(srcDir, dstDir, res, depth) {
  if (depth > MAX_DEPTH) { res.errors.push(srcDir + "：目录层级过深，已跳过"); return; }
  let entries = [];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (e) {
    res.errors.push(srcDir + "：" + errText(e));
    return;
  }
  try { fs.mkdirSync(dstDir, { recursive: true }); }
  catch (e) { res.errors.push(dstDir + "：" + errText(e)); return; }

  for (const e of entries) {
    if (res.moved + res.skipped >= MIGRATE_LIMIT) { res.truncated = true; res.errors.push("超出单次搬迁上限，已中断"); return; }
    if (e.name === TMP_DIRNAME) continue;             // 临时目录：半成品文件，不搬
    if (e.name.endsWith(".part")) continue;           // 未收尾的分片，同理
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    try {
      if (e.isDirectory()) {
        copyTree(s, d, res, depth + 1);
      } else if (e.isFile()) {
        // 同名已存在就跳过（force:false 语义）：不覆盖目标侧的现有文件，
        // 万一之前搬了一半又切回旧根录过东西，旧文件不该被同名的新成果盖掉。
        if (fs.existsSync(d)) { res.skipped += 1; continue; }
        fs.copyFileSync(s, d);
        res.moved += 1;
        try { res.bytes += fs.statSync(d).size; } catch { /* 大小不重要 */ }
      }
    } catch (err) {
      res.ok = false;
      res.errors.push(s + "：" + errText(err));
    }
  }
}

/**
 * 把旧根下的三个子目录搬到新根。
 * **只复制不删除**：源文件一律保留。用户换错地方还能回去拿，
 * 而一次误删是不可逆的 —— 少删一个目录的收益远大于多占一点空间。
 * @param {{from?: string}} [opts]
 * @returns {{ok: boolean, from: string, to: string, moved: number, skipped: number,
 *            bytes: number, errors: string[], note: string|null}}
 */
function migrate(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const s = ctx.getState() || {};
  const to = resolveRoot();
  const rawFrom = (typeof o.from === "string" && o.from.trim())
    ? o.from.trim()
    : (typeof s.storageRootPrev === "string" ? s.storageRootPrev : "");
  const res = { ok: true, from: "", to, moved: 0, skipped: 0, bytes: 0, errors: [], note: null, truncated: false };

  if (!rawFrom.trim()) { res.ok = false; res.errors.push("没有记录旧存储目录，无需搬迁"); return res; }
  const from = path.resolve(rawFrom);
  res.from = from;
  if (from === to) { res.note = "新旧存储目录相同，无需搬迁"; return res; }
  if (isInside(to, from)) { res.ok = false; res.errors.push("旧目录位于新目录内部，搬迁会造成自我嵌套"); return res; }

  ensureSubdirs();   // 目标子目录必须先在，否则 copyTree 第一条 mkdir 也可能失败
  for (const kind of Object.keys(SUBDIRS)) {
    const src = path.join(from, SUBDIRS[kind]);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(to, SUBDIRS[kind]), res, 0);
  }
  // 搬完就把 Prev 清掉：否则下次设置面板还会一直显示「有旧数据待搬迁」
  if (res.moved > 0 || (!res.errors.length && res.skipped > 0)) ctx.setState({ storageRootPrev: "" });
  note("migrate:", from, "->", to, "moved =", res.moved, "skipped =", res.skipped);
  return res;
}

/**
 * 在资源管理器里打开某个子目录。
 * 先建目录再打开：shell.openPath 对不存在的路径会静默失败，
 * 用户点了没反应，很难联想到「目录还没创建」。
 * @param {"recordings"|"history"|"screenshots"|"vidx"} kind
 * @returns {Promise<{ok: boolean, path: string|null, error: string|null}>}
 */
async function openSubdir(kind) {
  const dir = pathOf(kind);
  if (!dir) return { ok: false, path: null, error: "未知的子目录类型：" + String(kind) };
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, path: dir, error: "目录创建失败：" + errText(e) };
  }
  try {
    const ret = await shell.openPath(dir);
    // openPath 成功返回空串，失败返回错误描述；不能只看返回值是不是空 —— 有些平台啥也不返回
    return ret ? { ok: false, path: dir, error: String(ret) } : { ok: true, path: dir, error: null };
  } catch (e) {
    return { ok: false, path: dir, error: errText(e) };
  }
}

/* ---------------- 看视频产物：原始媒体到期清理 ----------------
 * 结构约定（与文档第十三章一致）：vidx/<key>/ 下一个来源一个子目录，
 *   L1 事实  meta.json / probe.json / transcript.json / frames/
 *   L2 可读  index.md / timeline.md      ← Agent 主读，要长期留着
 *   L3 结论  report.md / skill.md / evidence.md
 *   L4 原始  media/                      ← 视频/音频原件，体积全在这里
 * 用户已拍板：**L4 只留 7 天**，到点删文件。L1~L3 都是纯文本，几十 KB，
 * 永久保留 —— 删了等于把"看过什么"也一起删掉，而那正是复盘要用的东西。
 *
 * 为什么按 mtime 而不是目录名里的日期：录制/下载/转存都可能改写 mtime，
 * 但"最后一次被写"本来就晚于"第一次进来"，用它当到期判据只会更保守（晚删一点），
 * 不会误删。反过来按名字里的日期，一旦命名规则变了就整批不清。
 */
const VIDX_MEDIA_KEEP_DAYS = 7;

/** 收集 vidx 下所有名为 media/source 的目录（限制深度，防止用户把别的东西塞进来）。 */
function collectMediaDirs(dir, out, depth) {
  if (depth > 4) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === "media" || e.name === "source") out.push(p);
    else collectMediaDirs(p, out, depth + 1);
  }
}

/**
 * 删掉 vidx 下超过 keepDays 天的原始媒体文件（不动文本产物）。
 * 幂等、可反复调用；任何一步失败都只跳过那一个文件，不中断整轮。
 * @param {number} [keepDays]
 * @returns {{ok: boolean, days: number, dirs: number, removed: number, freed: number, failed: number}}
 */
function purgeVidxMedia(keepDays) {
  const days = Number(keepDays) > 0 ? Number(keepDays) : VIDX_MEDIA_KEEP_DAYS;
  const res = { ok: true, days, dirs: 0, removed: 0, freed: 0, failed: 0 };
  const root = pathOf("vidx");
  if (!root) return res;
  try { if (!fs.existsSync(root)) return res; } catch { return res; }
  const cut = Date.now() - days * 86400000;
  const dirs = [];
  collectMediaDirs(root, dirs, 0);
  res.dirs = dirs.length;
  for (const d of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;            // 子目录不碰：宁可少清，不可误删
        if (st.mtimeMs >= cut) continue;       // 还没到期
        fs.unlinkSync(p);
        res.removed += 1;
        res.freed += st.size;
      } catch {
        /* 删不掉（被播放器占着 / 权限）就留着，下一轮再试。
           绝不能把它算成"已清"，否则用户以为空间回来了。 */
        res.failed += 1;
        res.ok = false;
      }
    }
  }
  return res;
}

module.exports = {
  SUBDIRS,
  TMP_DIRNAME,
  VIDX_MEDIA_KEEP_DAYS,
  init,
  resolveRoot,
  pathOf,
  ensureSubdirs,
  stat,
  setRoot,
  migrate,
  openSubdir,
  purgeVidxMedia,
};
