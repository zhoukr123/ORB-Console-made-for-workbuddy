/**
 * 一次性补交脚本：把某条历史「看视频」任务（在旧存储根）合成「内容提要 + 关键截图」MD，
 * 直接落盘并登记到【新存储根】的产物树，使它在 ORB 重启后出现在产物展示浮层。
 *
 * 用法：node orb/vidxSynthOnce.mjs
 * 改任务时改下面的 OLD_JOB_DIR / VID_KEY。
 */
import path from "node:path";
import { createLayout } from "./artifactLayout.mjs";
import { createArtifactStore } from "./artifactStore.mjs";
import { rootKeyOf } from "./artifactView.mjs";
import { synthesizeVidxMd } from "./vidxSynth.mjs";

const OLD_ROOT = "D:\\workbuddy_ORB控制台";
const NEW_ROOT = "D:\\workbuddy_ORB控制台\\ORB存储";
const CID = "c-1794016630628-1";
const DAY = "2026-11-07";
const VID_KEY = "20261107-095710-4pfm";
const OLD_JOB_DIR = path.join(OLD_ROOT, "artifacts", DAY, "sessions", CID, "vidx", VID_KEY);

const writeLayout = createLayout({ root: NEW_ROOT });
const syn = synthesizeVidxMd({ layout: writeLayout, jobDir: OLD_JOB_DIR, cid: CID, day: DAY, count: 12 });
if (!syn.ok) {
  console.error("合成失败：", syn.error);
  process.exit(1);
}
console.log("合成成功 →", syn.mdPath);
console.log("关键帧：", syn.count, "张，目录：", syn.framesDir);

// 登记到新根的 governance/<day> 登记表（与线上 registerArtifact 同目录、同形状）
const store = createArtifactStore({
  dir: () => path.join(NEW_ROOT, "governance", syn.day),
});
const reg = store.register({
  conversationId: syn.cid,
  epoch: 0,
  ticketId: "",
  kind: "exports",
  rel: syn.rel,
  ext: "md",
  size: syn.size,
  sha: "",
  rootKey: rootKeyOf(NEW_ROOT),
});
if (!reg.ok) {
  console.error("登记失败：", reg.reason || reg);
  process.exit(1);
}
console.log("登记成功 → artifactId:", reg.id, "rel:", syn.rel);
console.log("重启 ORB 控制台后，该 MD 即出现在对应会话的产物展示浮层。");
