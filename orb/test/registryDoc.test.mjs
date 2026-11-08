/* 注册表文档漂移检测。
 *
 * 不重复实现生成逻辑（那会变成第三份抄写）；直接跑生成器的 --check 模式。
 * 这样单测和 CI 用的是同一条判定路径：只要 `--check` 退 0，文档就是源码的投影。
 *
 * 什么时候会红：增删模块、改导出名、改模块头部说明、改能力清单/状态写入器/指标/日志分类。
 * 什么时候不该红：改函数体、修 bug、加注释 —— 这些不影响"结构"，也就不该让文档变。
 * （行数被故意排除在文档之外，就是为了让这类改动不产生噪音。）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

test("docs/registry.md 与源码结构一致", () => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, "tools", "gen-registry-doc.mjs"), "--check"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    assert.fail(`注册表文档漂移了：${(err.stdout || "") + (err.stderr || "")}\n` +
      `修法：node orb/tools/gen-registry-doc.mjs`);
  }
  assert.match(out, /REG_OK/, "生成器没回 REG_OK，说明 --check 没走到通过分支");
});

test("docs/capabilities.md 与能力清单一致", () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, "tools", "gen-capabilities-doc.mjs"), "--check"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    assert.fail(`能力文档漂移了：${(err.stdout || "") + (err.stderr || "")}\n` +
      `修法：node orb/tools/gen-capabilities-doc.mjs`);
  }
});
