/**
 * ESM 侧入口：实现只有 desktop/mdEscape.cjs 一份，这里做转发。
 * bridge / exporter 等 .mjs 模块统一从本文件 import。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const impl = require("./desktop/mdEscape.cjs");

export const {
  MAX_LEN, FRAME_RE, FM_KEYS,
  toText, stripSecrets, escapeHtml, escapeInline, escapeBlock,
  safeTitle, safeLink, frameRef, frontMatter, buildSourceDoc,
} = impl;
export default impl;
