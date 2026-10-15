/*
 * 同步可用的 API Key 到我们自己的 DSH 凭据副本。
 *
 * 背景：用户在「视觉设置 → 备选」里填了一个可用的 key，但 DSH 后台轨道读的是
 * .credentials.yaml 中 refs.CSCS_API_KEY（那是失效的旧值），两者不是同一把。
 * 所以后台 Agent 经 bridge 走会 AUTH 失败——只有直接传视觉槽的 key 才能跑通。
 *
 * 这里把视觉槽里可用的 key 写回我们自己的凭据副本的 refs.CSCS_API_KEY，
 * 让两条轨道用同一把有效的 key。
 *
 * 注意：refs 下的键是有缩进的（"  CSCS_API_KEY:"），正则必须吃掉缩进，
 * 否则会误在顶层新增一条，而 refs 里的旧值根本没被改掉。
 */
import fs from "node:fs";
import path from "node:path";

const CRED = process.env.ORB_DSH_CRED
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy", "orb-dsh", ".credentials.yaml");
const STATE = "desktop/.orbdata/orb-state.json";

const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
const v = st.vision || {};
const key = [v.backup?.apiKey, v.primary?.apiKey].find((k) => k && k.length >= 16);

if (!key) {
  console.log("视觉槽里没有可用的 key，跳过同步");
  process.exit(0);
}

const lines = fs.readFileSync(CRED, "utf8").split(/\r?\n/);

// 先删掉所有误加到顶层的 CSCS_API_KEY（缩进为 0 的那些）
const cleaned = lines.filter((l) => !/^CSCS_API_KEY\s*:/.test(l));

// 再替换 refs 下带缩进的那一条
let hit = false;
const out = cleaned.map((l) => {
  const m = l.match(/^(\s*)CSCS_API_KEY\s*:\s*\S+/);
  if (m) { hit = true; return `${m[1]}CSCS_API_KEY: ${key}`; }
  return l;
});

if (!hit) {
  // refs 段下没有，就插到 refs: 后面
  const i = out.findIndex((l) => /^refs\s*:/.test(l));
  if (i >= 0) out.splice(i + 1, 0, `  CSCS_API_KEY: ${key}`);
  else out.push("refs:", `  CSCS_API_KEY: ${key}`);
}

fs.writeFileSync(CRED, out.join("\n"));
console.log("已同步 refs.CSCS_API_KEY（长度 " + key.length + "）");
