import fs from "node:fs";
import path from "node:path";

/*
 * 给 cnoke.cjs 打最小补丁（可重复执行）。
 *
 * 原因：cnoke 用 spawnSync 做「有没有这个工具」的探测，默认是管道 stdio。
 * 在当前受限环境里，带管道的同步 spawn 会被拦截并返回 EBUSY（status=null），
 * 于是探测一律失败：
 *   - checkCMake() 失败  -> 误报「CMake 不可用」
 *   - ninja 探测失败     -> 生成器退回 "MinGW Makefiles"（本机没有）而配置失败
 * 这两处都只取退出码、不需要 stdout，加 stdio:'ignore' 后语义完全等价。
 *
 * 异步 spawn / execFile / stdio:'ignore' 都正常，只有「同步 + 管道」被拦。
 */
const FILE = process.env.ORB_CNOKE_FILE || path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".workbuddy", "orb-dsh", "profiles", "node_modules",
  "@deepseek-ai", "node_modules", "koffi", "cnoke.cjs",
);

const PATCHES = [
  {
    name: "checkCMake",
    old: 'let proc = (0, import_node_child_process.spawnSync)("cmake", ["--version"]);',
    neu: 'let proc = (0, import_node_child_process.spawnSync)("cmake", ["--version"], { stdio: "ignore" });',
  },
  {
    name: "ninja 探测",
    old: 'if ((0, import_node_child_process.spawnSync)("ninja", ["--version"]).status === 0) {',
    neu: 'if ((0, import_node_child_process.spawnSync)("ninja", ["--version"], { stdio: "ignore" }).status === 0) {',
  },
];

let src = fs.readFileSync(FILE, "utf8");
let changed = 0;

for (const p of PATCHES) {
  if (src.includes(p.neu)) {
    console.log(`  [已打过] ${p.name}`);
  } else if (src.includes(p.old)) {
    src = src.replace(p.old, p.neu);
    changed++;
    console.log(`  [已修改] ${p.name}`);
  } else {
    console.log(`  [找不到] ${p.name} —— 版本可能不同，需人工确认`);
  }
}

if (changed) {
  fs.writeFileSync(FILE, src);
  console.log(`补丁写入完成（${changed} 处）`);
} else {
  console.log("无需改动");
}
