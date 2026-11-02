/* ---------------- 站点凭据库（系统加密保护） ----------------
 * 设置 › 安全 里"我的站点"这一栏的落地层，同时接管视觉模型的 API Key。
 *
 * 为什么用 safeStorage 而不是自己写 AES：
 *   自研加密 = 自己要管密钥从哪来、怎么派生、怎么轮换，每一步都会错。
 *   safeStorage 在 Windows 上走 DPAPI，密文绑定「当前 Windows 用户 + 当前机器」，
 *   换机器或重装系统就解不开 —— 这正是我们想要的（本地工具，不需要跨设备同步）。
 *
 * 为什么单独 vault.bin 而不混进 orb-state.json：
 *   state 会被备份、被迁移、被用户贴进工单里看；凭据必须物理分开。
 *
 * 为什么不存密码（用户已拍板）：
 *   persist:<partition> 分区的 Cookie 跨进程持久，用户在 ORB 里登录一次就够了。
 *   存密码只对"登录态被踢后自动重登"有意义，而验证码/OTP 会把它卡死，
 *   收益远小于风险。所以这里只存「站点 + 账户」，密码永远不落盘。
 *
 * 硬约定：
 *   ① isEncryptionAvailable() 为 false 时**拒绝写入**，绝不降级明文。
 *      注意"拒绝写入"只针对新增/修改，读取时返回空库 —— 否则老数据也读不出来。
 *   ② 写盘一律 .tmp + rename（与 main.js 的 saveState 同一套），断电不留半个文件。
 *   ③ 本模块不碰 state、不碰窗口、不在顶层调用任何 ready-gated API。
 */

const fs = require("node:fs");
const path = require("node:path");

/* 宿主上下文（由 main.js 注入）：本模块不自己算 userData ——
   那会撞上 app.setPath("userData") 的执行时机，早调用就落到默认目录去了。 */
let ctx = {
  file: () => "",
  log: () => {},
};

function init(next) {
  if (!next || typeof next !== "object") return;
  if (typeof next.file === "function") ctx.file = next.file;
  if (typeof next.log === "function") ctx.log = next.log;
}

function note(...args) {
  try { ctx.log("[vault]", ...args); } catch { /* 日志绝不能反咬调用方 */ }
}

function errText(e) {
  return (e && e.message) ? e.message : String(e);
}

function empty() {
  return { version: 1, sites: [], vision: {} };
}

/* safeStorage 是 ready-gated API：只在调用点取，绝不在模块顶层解构。
   require("electron") 本身是安全的（主进程内建），但不值得赌。 */
function cryptoApi() {
  try {
    const m = require("electron");
    return m && m.safeStorage ? m.safeStorage : null;
  } catch {
    return null;
  }
}

/** 本机是否具备系统加密能力。UI 据此决定是否允许新增站点。 */
function isAvailable() {
  try {
    const s = cryptoApi();
    return !!s && s.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

function filePath() {
  const p = ctx.file();
  return typeof p === "string" ? p : "";
}

/** 读并解密。任何异常都回空库 —— 读不出来不该让设置页整页崩掉。 */
function read() {
  const f = filePath();
  if (!f || !isAvailable()) return empty();
  let raw = "";
  try { raw = fs.readFileSync(f, "utf8"); } catch { return empty(); }
  if (!raw.trim()) return empty();
  try {
    const buf = Buffer.from(raw.trim(), "base64");
    const plain = cryptoApi().decryptString(buf);
    const o = JSON.parse(plain) || {};
    return {
      version: 1,
      sites: Array.isArray(o.sites) ? o.sites.filter((x) => x && typeof x === "object" && x.origin) : [],
      vision: (o.vision && typeof o.vision === "object") ? o.vision : {},
    };
  } catch (e) {
    /* 解密失败最常见的原因是换了机器/换了 Windows 账户 —— 这时旧密文再也解不开。
       不能静默当空库就算了，必须留痕，否则用户会以为凭据"自己丢了"。 */
    note("解密失败（可能是换了机器或系统账户）:", errText(e));
    return empty();
  }
}

/** 加密并原子写。 */
function write(data) {
  if (!isAvailable()) {
    return { ok: false, error: "本机不支持系统加密（safeStorage 不可用），为安全起见拒绝保存" };
  }
  const f = filePath();
  if (!f) return { ok: false, error: "凭据文件路径无效" };
  try {
    const buf = cryptoApi().encryptString(JSON.stringify(data));
    const b64 = buf.toString("base64");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, b64, "utf8");
    fs.renameSync(tmp, f);          // 同目录 rename 在 NTFS 上是原子的
    try { fs.chmodSync(f, 0o600); } catch { /* Windows 下可能不支持，忽略 */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ---------------- 站点 ----------------
 * 一律归一化成 origin（scheme + host），这样「一站点一条」，
 * 用户填 https://github.com/xxx 和 github.com 会被认成同一条。 */
function normalizeOrigin(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (s.length > 500) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 对外形状：绝不带任何密钥字段。 */
function publicSite(s) {
  return {
    id: String(s.id || ""),
    origin: String(s.origin || ""),
    user: String(s.user || ""),
    note: String(s.note || ""),
    createdAt: Number(s.createdAt) || 0,
    lastUsedAt: Number(s.lastUsedAt) || 0,
  };
}

function listSites() {
  return read().sites.map(publicSite).sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt));
}

function addSite(input) {
  const p = (input && typeof input === "object") ? input : {};
  const origin = normalizeOrigin(p.origin);
  if (!origin) return { ok: false, error: "网址无效：需要 http:// 或 https:// 的站点地址" };
  const user = String(p.user || "").trim().slice(0, 120);
  const note = String(p.note || "").trim().slice(0, 200);

  const d = read();
  const dup = d.sites.find((s) => String(s.origin) === origin && String(s.user || "") === user);
  if (dup) return { ok: false, error: "这个站点和账户已经记过了" };

  const item = { id: newId(), origin, user, note, createdAt: Date.now(), lastUsedAt: 0 };
  d.sites.push(item);
  const w = write(d);
  if (!w.ok) return w;
  return { ok: true, site: publicSite(item), sites: listSites() };
}

function removeSite(id) {
  const key = String(id || "");
  if (!key) return { ok: false, error: "缺少 id" };
  const d = read();
  const before = d.sites.length;
  d.sites = d.sites.filter((s) => String(s.id) !== key);
  if (d.sites.length === before) return { ok: false, error: "没有找到这条记录" };
  const w = write(d);
  if (!w.ok) return w;
  return { ok: true, sites: listSites() };
}

/** 标记一次使用（用于「上次使用」排序；失败不影响主流程）。 */
function touchSite(id) {
  const key = String(id || "");
  if (!key) return { ok: false };
  const d = read();
  const s = d.sites.find((x) => String(x.id) === key);
  if (!s) return { ok: false };
  s.lastUsedAt = Date.now();
  return write(d);
}

function updateSite(id, patch) {
  const key = String(id || "");
  const p = (patch && typeof patch === "object") ? patch : {};
  const d = read();
  const s = d.sites.find((x) => String(x.id) === key);
  if (!s) return { ok: false, error: "没有找到这条记录" };
  if ("user" in p) s.user = String(p.user || "").trim().slice(0, 120);
  if ("note" in p) s.note = String(p.note || "").trim().slice(0, 200);
  const w = write(d);
  if (!w.ok) return w;
  return { ok: true, site: publicSite(s), sites: listSites() };
}

/* ---------------- 视觉模型 API Key ----------------
 * 只提供服务端读写接口，**不导出任何列表类方法** ——
 * 防止某个新加的通道顺手把整库倒给渲染层。 */
function getVisionKey(slot) {
  const d = read();
  return String((d.vision && d.vision[slot || "primary"]) || "");
}

function hasVisionKey(slot) {
  return !!getVisionKey(slot);
}

function setVisionKey(slot, key) {
  const k = String(slot || "primary");
  if (k !== "primary" && k !== "backup") return { ok: false, error: "未知槽位" };
  const d = read();
  if (!d.vision) d.vision = {};
  const v = typeof key === "string" ? key.trim() : "";
  if (v) d.vision[k] = v;
  else delete d.vision[k];
  return write(d);
}

module.exports = {
  init,
  isAvailable,
  listSites,
  addSite,
  removeSite,
  updateSite,
  touchSite,
  getVisionKey,
  hasVisionKey,
  setVisionKey,
  /* 仅供自检/诊断用，不接任何 IPC */
  _read: read,
};
