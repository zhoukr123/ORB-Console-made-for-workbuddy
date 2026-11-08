/* ---------------- 命令通道危险判定（硬闸） ----------------
 *
 * 为什么单独成文件且是"纯函数"：
 *   bridge 里既有的 DANGER 机制（DANGER_TOOLS / dangerByArgs / 白名单）是**可配置**的，
 *   而且配置来自 danger-tools.json —— **老用户的旧配置不会自动补齐新规则**。
 *   如果只把"移动/重命名"塞进默认配置，那台机器上只要有一份旧的 danger-tools.json，
 *   危险操作就能裸奔。这正是"危险难拦截"的典型漏洞。
 *
 * 所以这里把不可退让的部分做成**代码级硬闸**：
 *   · move / rename —— 源文件会消失，无条件需确认；
 *   · copy 且 overwrite=true —— 会毁掉目标，无条件需确认。
 *   这三类**不读配置、不受白名单影响**（白名单也不该能放行"删源"）。
 *
 * 其余（write / launch / openWith / 非覆盖的 copy）仍交给 bridge 的可配置 DANGER，
 * 保持与既有治理层一致的口径。
 */

/**
 * 把命令通道的操作体归一成"可判定参数"，供硬闸 / dangerByArgs / 白名单统一使用。
 * @param {object} body  {write?|launch?|openWith?|copy?|move?|rename?}
 * @returns {object} 带 op 的参数对象
 */
export function commandChannelArgs(body = {}) {
  const s = (v) => String(v ?? "");
  if (body.copy) {
    return { op: "copy", from: s(body.copy.from), to: s(body.copy.to), overwrite: body.copy.overwrite === true ? "true" : "false" };
  }
  if (body.move) {
    return { op: "move", from: s(body.move.from), to: s(body.move.to), overwrite: body.move.overwrite === true ? "true" : "false" };
  }
  if (body.rename) {
    return { op: "rename", from: s(body.rename.from), to: s(body.rename.to), overwrite: body.rename.overwrite === true ? "true" : "false" };
  }
  if (body.launch) {
    return { op: "launch", command: s(body.launch.command), args: body.launch.args ?? [] };
  }
  if (body.openWith) {
    return { op: "openWith", command: s(body.openWith.app), path: s(body.openWith.filePath) };
  }
  if (body.write) {
    return { op: "write", path: s(body.write.filePath) };
  }
  return { op: "" };
}

/**
 * 硬闸：返回"必须确认"的原因；空串表示不属于硬闸（交给可配置 DANGER 判断）。
 * @param {object} args  commandChannelArgs() 的结果
 * @returns {string}
 */
export function hardDangerOp(args = {}) {
  const op = String(args.op || "");
  if (op === "move") return "移动会让源文件消失";
  if (op === "rename") return "重命名会让源文件消失";
  if (op === "copy" && String(args.overwrite) === "true") return "复制并覆盖会毁掉目标";
  return "";
}
