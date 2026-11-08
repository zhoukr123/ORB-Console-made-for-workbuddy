/* ---------------- 自动化回收站（wfTrash） ----------------
 *
 * 删除自动化不再 unlink，而是移到同级 workflows-trash/，留出撤销窗口。
 * 依据：删除一个可重建的录制配方属于「可逆操作」，不该用 type-to-confirm；
 * 但必须真的可逆 —— 只把弹窗改成两个按钮而不给退路，等于把风险转嫁给用户。
 *
 * 三条硬约束：
 *   ① 不覆盖：恢复时若已存在同名自动化，直接拒绝，绝不悄悄盖掉用户新录的内容。
 *   ② 不穿越：trashId 由本模块生成、恢复时按白名单校验，不接受外部拼出的路径。
 *   ③ 回退：renameSync 跨卷会 EXDEV，退化成 copy + unlink（本机 D:/ 与 APPDATA 同卷，
 *      但便携版/迁移场景不保证）。
 */
import fsDefault from "node:fs";
import path from "node:path";

const DEFAULT_SAFE = (s) => String(s || "workflow")
  .replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "workflow";

const TRASH_ID_RE = /^[A-Za-z0-9_.\-]+\.json$/;

export function createWfTrash(opts = {}) {
  const fs = opts.fs || fsDefault;
  const dir = String(opts.dir || "");
  const trashDir = String(opts.trashDir || "");
  const safeName = typeof opts.safeName === "function" ? opts.safeName : DEFAULT_SAFE;
  const now = typeof opts.now === "function" ? opts.now : Date.now;

  if (!dir || !trashDir) throw new Error("wfTrash: dir / trashDir 必填");

  const fileOf = (name) => path.join(dir, safeName(name) + ".json");

  function move(src, dst) {
    try {
      fs.renameSync(src, dst);
    } catch (err) {
      if (!err || err.code !== "EXDEV") throw err;
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    }
  }

  /** 移入回收站。返回 { ok, trashId, name, steps } 或 { ok:false, error }。 */
  function remove(name) {
    const src = fileOf(name);
    try {
      if (!fs.existsSync(src)) return { ok: false, error: "自动化不存在或已被删除" };
      let steps = 0;
      try {
        const wf = JSON.parse(fs.readFileSync(src, "utf8"));
        steps = Array.isArray(wf.steps) ? wf.steps.length : 0;
      } catch { /* 内容损坏也允许移走，别把坏文件卡在列表里 */ }
      fs.mkdirSync(trashDir, { recursive: true });
      const base = safeName(name);
      let trashId = `${base}.${now()}.json`;
      for (let n = 1; fs.existsSync(path.join(trashDir, trashId)); n++) {
        trashId = `${base}.${now()}.${n}.json`;
      }
      move(src, path.join(trashDir, trashId));
      return { ok: true, trashId, name: base, steps };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** 从回收站恢复。同名已存在时拒绝，不覆盖。 */
  function restore(trashId) {
    const tid = String(trashId || "");
    if (!TRASH_ID_RE.test(tid) || tid.includes("..")) {
      return { ok: false, error: "非法的回收站条目" };
    }
    const src = path.join(trashDir, tid);
    try {
      if (!fs.existsSync(src)) return { ok: false, error: "回收站条目已不存在" };
      let wf;
      try { wf = JSON.parse(fs.readFileSync(src, "utf8")); }
      catch { return { ok: false, error: "回收站条目内容损坏，无法恢复" }; }
      const name = safeName(wf.name);
      const dst = fileOf(name);
      if (fs.existsSync(dst)) {
        return { ok: false, error: `已存在同名自动化「${name}」，未恢复（请先重命名当前那条）` };
      }
      move(src, dst);
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** 回收站列表：给「自动化 › 回收站」用，损坏条目也如实列出，不静默吞掉。 */
  function list() {
    try {
      return fs.readdirSync(trashDir)
        .filter((f) => TRASH_ID_RE.test(f) && !f.includes(".."))
        .map((f) => {
          const p = path.join(trashDir, f);
          try {
            const st = fs.statSync(p);
            const wf = JSON.parse(fs.readFileSync(p, "utf8"));
            return { trashId: f, name: safeName(wf.name),
              steps: Array.isArray(wf.steps) ? wf.steps.length : 0,
              deletedAt: Math.round(st.mtimeMs), size: st.size, damaged: false };
          } catch {
            return { trashId: f, name: "", steps: 0, deletedAt: 0, size: 0, damaged: true };
          }
        })
        .sort((a, b) => b.deletedAt - a.deletedAt);
    } catch { return []; }
  }

  /** TTL + 上限清理。**只由用户显式触发**，不在启动时偷偷删数据。 */
  function sweep(opts = {}) {
    const ttlMs = Number(opts.ttlMs) || 30 * 24 * 3600 * 1000;
    const max = Number(opts.max) || 200;
    const t = now();
    const all = list();
    const removed = [];
    const unlink = (e) => {
      try { fs.unlinkSync(path.join(trashDir, e.trashId)); removed.push(e.trashId); } catch {}
    };
    for (const e of all) {
      if (e.deletedAt && t - e.deletedAt > ttlMs) unlink(e);
    }
    const left = all.filter((e) => !removed.includes(e.trashId) && e.deletedAt);
    if (left.length > max) for (const e of left.slice(max)) unlink(e);
    return { removed, remaining: list().length };
  }

  return { fileOf, remove, restore, list, sweep, trashDir };
}
