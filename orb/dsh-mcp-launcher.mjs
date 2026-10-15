/*
 * dsh-mcp 启动器
 *
 * 为什么不直接把 API Key 写进 mcp.json：
 *   密钥属于凭据，不该散落在多个配置文件里。这里在启动时从
 *   DSH 凭据文件读一次，注入环境变量后再启动 dsh-mcp，
 *   配置文件里只留路径。
 *
 * 另外把 DSH_ROOT / DSH_HOME 指向我们自己的副本
 * （%USERPROFILE%\.workbuddy\orb-dsh），这样删掉 DeepSeek Orb 也不受影响。
 *
 * 顺带解决了 dsh-mcp 的一个硬要求：它启动时会检查 process.env.DEEPSEEK_API_KEY，
 * 没有就直接报错退出（"DEEPSEEK_API_KEY is not configured"）。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ORB_DSH = process.env.ORB_DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy", "orb-dsh");
const DSH_ROOT = process.env.DSH_ROOT
  || path.join(ORB_DSH, "profiles", "node_modules", "@deepseek-ai", "node_modules", "@deepseek-ai", "dsh");

process.env.DSH_HOME = process.env.DSH_HOME || ORB_DSH;
process.env.DSH_ROOT = DSH_ROOT;

/** 从凭据文件里取一个 key。凭据文件是简单的扁平 YAML，用正则足够，也不必引入 yaml 依赖。 */
function readCredential(name) {
  if (process.env[name]) return process.env[name];
  try {
    const txt = fs.readFileSync(path.join(ORB_DSH, ".credentials.yaml"), "utf8");
    const m = txt.match(new RegExp(name + ":\\s*([A-Za-z0-9._\\-]{16,})"));
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

const key = readCredential("DEEPSEEK_API_KEY");
if (key) process.env.DEEPSEEK_API_KEY = key;

/* dsh-mcp 入口：与 ORB_DSH 同源，装在 %USERPROFILE%\.workbuddy\tools\dsh-mcp 下。
 * 原来这里写死了作者机器的绝对路径，换机器必挂，也不再随仓库公开。 */
const DSH_MCP = process.env.ORB_DSH_MCP || path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".workbuddy", "tools", "dsh-mcp", "dist", "index.js",
);

// 诊断信息走 stderr，不能污染 stdout —— stdio MCP 的 stdout 只跑协议帧
process.stderr.write(
  `[dsh-launcher] DSH_ROOT=${DSH_ROOT}\n`
  + `[dsh-launcher] DSH_HOME=${process.env.DSH_HOME}\n`
  + `[dsh-launcher] DSH_MCP=${DSH_MCP}\n`
  + `[dsh-launcher] DEEPSEEK_API_KEY=${key ? "已从凭据注入(len=" + key.length + ")" : "缺失"}\n`
);

await import(pathToFileURL(DSH_MCP).href);
