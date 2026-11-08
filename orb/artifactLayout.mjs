/**
 * ESM 侧入口：实现只有 desktop/artifactLayout.cjs 一份，这里做转发。
 * bridge / exporter 等 .mjs 模块统一从本文件 import。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const impl = require("./desktop/artifactLayout.cjs");

export const { dayOf, safeId, KINDS, createLayout } = impl;
export default impl;
