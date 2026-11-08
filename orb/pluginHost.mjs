/**
 * pluginHost.mjs — 插件转化底座（方案条目 I-23 窄版：协议底座 + 前 2 项 S 级工具）
 *
 * 设计取舍：
 * 1. 只做「契约 + 注册表 + 执行」，不做插件发现、不做动态 import、不读写磁盘。
 *    插件必须是同进程内的纯 JS 对象，来源由调用方负责，Host 只负责校验与执行。
 *    （窄版先立契约，等真有第二批插件再谈加载方式，避免过早设计。）
 * 2. 对外方法一律返回 { ok, ... }，永不抛异常：控制台是长驻进程，
 *    一个插件的异常不能顺着调用链把上层带崩，只能被记录成一条 failed。
 * 3. 内置工具是纯函数：给定输入必给同一输出，不取当前时间、不取随机数。
 *    二维码掩码固定用 mask 0，就是为了输出可复现、可做快照比对与回归。
 * 4. 二维码是从零写的实现，不引任何第三方依赖：许可约束是「只翻契约重写实现」，
 *    所以这里按 ISO/IEC 18004 自己写 byte 模式编码（version 1-10 / L-M-Q-H）。
 * 5. 正则流水线把「用户给的正则」当不可信输入：限条数、限长度、限 flags，
 *    并且单条编译失败只跳过该条，不让一条坏规则毁掉整条流水线。
 * 6. 11-07 简报 §3.3：带 origin 的插件（模型生成物 / 外部导入）必须先过三段式
 *    声明式验收闸门，restart-required 不算成功；生成物不得直接注册进 /api/call。
 *    内置插件无 origin，走原来的轻量路径，不受影响。
 */
import { createArtifactGate } from "./pluginArtifactGate.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LEVELS = new Set(["S", "A"]);

/* ------------------------------------------------------------------ *
 * 内置插件 1：regex-pipeline（正则流水线）
 * ------------------------------------------------------------------ */

const REGEX_LIMITS = {
  maxRules: 50, // 再多也不是「流水线」了，是暴力脚本
  maxPattern: 500, // 超过这个长度的 pattern 基本是机器生成的，先拒
  maxText: 1_000_000, // 默认输入上限，防止对 GB 级文本跑正则
  maxHits: 1_000_000, // 计数循环的兜底上限，防零宽匹配把循环拖死
};

/**
 * flags 白名单过滤。
 * 只保留 g i m s u——y（粘滞）会让 replace 行为依赖 lastIndex，
 * d（indices）纯属多余，v 与 u 互斥且会改变字符类语义，一律不要。
 * 顺带按固定顺序去重，保证同样的输入永远得到同样的 flags 字符串。
 */
function sanitizeFlags(flags) {
  if (typeof flags !== "string") return "";
  let out = "";
  for (const ch of "gimsu") if (flags.includes(ch)) out += ch;
  return out;
}

/**
 * 数一条规则命中多少次。
 * 非全局正则最多命中 1 次（与 String.replace 的语义保持一致），
 * 全局正则用 exec 循环，零宽匹配时手动前进 lastIndex，否则会死循环。
 */
function countMatches(text, pattern, flags) {
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return 0;
  }
  if (!flags.includes("g")) return re.test(text) ? 1 : 0;
  let n = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    n++;
    if (m[0] === "") re.lastIndex++;
    if (n >= REGEX_LIMITS.maxHits) break;
  }
  return n;
}

/**
 * run({ text, rules, limit })
 *   text  字符串（必填）
 *   rules [{ pattern, flags, replace }]，按数组顺序依次替换
 *   limit 输入长度上限（字符数），默认 1_000_000
 *
 * 返回 { ok:true, text, hits, applied, errors }
 *   hits[i]   第 i 条规则在它自己那一轮里命中了几次（替换前统计）
 *   applied   真正跑起来的规则条数（编译失败的、缺 pattern 的不算）
 *   errors    [{ index, error, detail? }]，只记录，不中断
 */
function runRegexPipeline(args = {}) {
  const text = args && args.text;
  if (typeof text !== "string") return { ok: false, error: "text-required" };

  const rawLimit = Number(args.limit);
  const maxText = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : REGEX_LIMITS.maxText;
  if (text.length > maxText) return { ok: false, error: "too-large" };

  const rules = Array.isArray(args.rules) ? args.rules : [];
  // 超限直接拒，不静默截断——静默截断会让用户以为后半段规则生效了。
  if (rules.length > REGEX_LIMITS.maxRules) return { ok: false, error: "too-many-rules" };

  let out = text;
  const hits = [];
  const errors = [];
  let applied = 0;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] && typeof rules[i] === "object" ? rules[i] : {};
    if (typeof rule.pattern !== "string" || rule.pattern === "") {
      hits.push(0);
      errors.push({ index: i, error: "pattern-required" });
      continue;
    }
    if (rule.pattern.length > REGEX_LIMITS.maxPattern) {
      hits.push(0);
      errors.push({ index: i, error: "pattern-too-long" });
      continue;
    }

    const flags = sanitizeFlags(rule.flags);
    try {
      // 先试编译，编译不过就跳过该条：一条坏规则不该让整条流水线整体失败。
      new RegExp(rule.pattern, flags);
    } catch (e) {
      hits.push(0);
      errors.push({ index: i, error: "bad-pattern", detail: String((e && e.message) || e) });
      continue;
    }

    const replaceWith = typeof rule.replace === "string" ? rule.replace : "";
    hits.push(countMatches(out, rule.pattern, flags));
    out = out.replace(new RegExp(rule.pattern, flags), replaceWith);
    applied++;
  }

  return { ok: true, text: out, hits, applied, errors };
}

/* ------------------------------------------------------------------ *
 * 内置插件 2：qr-encode（二维码）
 * 以下是完整实现，按 ISO/IEC 18004 分五步：
 *   ① 数据编码（byte 模式 → 比特流 → 码字）
 *   ② Reed-Solomon 纠错（GF(256)，本原多项式 0x11D）
 *   ③ 分块 + 交织
 *   ④ 功能图形 + 格式/版本信息
 *   ⑤ 数据布置 + 掩码
 * ------------------------------------------------------------------ */

/** EC 等级 → 格式信息里的 2 bit 编码（L=01 M=00 Q=11 H=10） */
const QR_EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * 每版本每 EC 等级的分块表：[每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]
 * 这张表直接来自标准，没得推导；两组数据的块数据码字数只差 1（v5 以后常见）。
 */
const QR_BLOCK_TABLE = [
  /* v1  */ { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  /* v2  */ { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  /* v3  */ { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  /* v4  */ { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  /* v5  */ { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  /* v6  */ { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  /* v7  */ { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  /* v8  */ { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  /* v9  */ { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  /* v10 */ { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
];

/** 对齐图形中心坐标（v1 没有对齐图形） */
const QR_ALIGN_CENTERS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** byte 模式的字符计数位数：v1-9 是 8 bit，v10-26 是 16 bit */
function qrCharCountBits(version) {
  return version <= 9 ? 8 : 16;
}

function qrDataCodewords(version, ec) {
  const [, n1, d1, n2, d2] = QR_BLOCK_TABLE[version - 1][ec];
  return n1 * d1 + n2 * d2;
}

/* ---- GF(256)：本原多项式 0x11D，生成元 2 ---- */

function gfMul(x, y) {
  let z = 0;
  // 逐位乘法：每轮先把 z 左移一位，溢出位（bit7）回代 0x11D 做模约简
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** 生成多项式 g(x) = (x-α^0)(x-α^1)...(x-α^(deg-1)) 的系数（首一，省略最高位） */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** 用生成多项式除数据码字，余数就是纠错码字 */
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ---- ③ 分块 + 交织 ---- */

function qrInterleave(dataCw, spec) {
  const [ecPerBlock, n1, d1, n2, d2] = spec;
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < n1; i++) {
    blocks.push(dataCw.slice(pos, pos + d1));
    pos += d1;
  }
  for (let i = 0; i < n2; i++) {
    blocks.push(dataCw.slice(pos, pos + d2));
    pos += d2;
  }
  const divisor = rsDivisor(ecPerBlock);
  const eccs = blocks.map((b) => rsRemainder(b, divisor));

  // 交织规则：先按列取数据码字（短块跳过），再按列取纠错码字。
  // 这样连续的多模块损坏会被均摊到各个块上，纠错才有意义。
  const out = [];
  const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const e of eccs) out.push(e[i]);
  }
  return out;
}

/* ---- ④ 格式信息 / 版本信息 ---- */

/** 格式信息 = 5 bit 数据（2 bit EC + 3 bit mask），BCH(15,5) 校验，再异或 0x5412 */
function qrFormatBits(ec, mask) {
  const data = (QR_EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

/** 版本信息（v>=7 才需要）= 6 bit 版本号 + BCH(18,6)，生成多项式 0x1F25 */
function qrVersionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

/* ---- ⑤ 矩阵构建 ---- */

function qrBuildMatrix(version, ec, allCodewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  // isFunc：功能图形 + 保留区。数据布置要绕开它们，掩码也不能翻它们。
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

  const setF = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    modules[row][col] = !!dark;
    isFunc[row][col] = true;
  };
  const bitOf = (n, i) => ((n >>> i) & 1) !== 0;

  // ① 三个定位图形 + 分隔符。dr/dc 取 -1..7 一圈，正好把 1 模块宽的分隔符（白）一起画了。
  const drawFinder = (row, col) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setF(row + dr, col + dc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // ② 时序图形：第 6 行 / 第 6 列，夹在两个定位图形之间（8 ~ size-9），偶数位置深色
  for (let i = 8; i < size - 8; i++) {
    setF(6, i, i % 2 === 0);
    setF(i, 6, i % 2 === 0);
  }

  // ③ 对齐图形 5x5：外环深、内圈浅、正中深。跳过压在定位图形上的三个角。
  const centers = QR_ALIGN_CENTERS[version - 1];
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cr = centers[i];
      const cc = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          // max(|dr|,|dc|) = 2 外环深，=1 内圈浅，=0 中心深
          setF(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // ④ 格式信息：15 bit 分两处写，互为副本（一处损坏靠另一处恢复）
  const fbits = qrFormatBits(ec, mask);
  for (let i = 0; i <= 5; i++) setF(i, 8, bitOf(fbits, i));
  setF(7, 8, bitOf(fbits, 6));
  setF(8, 8, bitOf(fbits, 7));
  setF(8, 7, bitOf(fbits, 8));
  for (let i = 9; i < 15; i++) setF(8, 14 - i, bitOf(fbits, i)); // 注意跳过第 6 列（时序图形）
  for (let i = 0; i < 8; i++) setF(8, size - 1 - i, bitOf(fbits, i));
  for (let i = 8; i < 15; i++) setF(size - 15 + i, 8, bitOf(fbits, i));
  setF(size - 8, 8, true); // 固定深色的「暗模块」，给扫描器定位用

  // ⑤ 版本信息（v>=7）：18 bit 写两组 3x6，右上 + 左下
  if (version >= 7) {
    const vbits = qrVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = bitOf(vbits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setF(b, a, dark);
      setF(a, b, dark);
    }
  }

  // ⑥ 数据布置：从右下角起，两列一组向上/向下蛇形，遇到功能图形就跳过
  let idx = 0;
  const totalBits = allCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 第 6 列是竖直时序图形，整列跳过（整体左移一列）
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (isFunc[row][col]) continue;
        if (idx < totalBits) {
          modules[row][col] = bitOf(allCodewords[idx >>> 3], 7 - (idx & 7));
          idx++;
        }
        // 码字用尽后剩下的模块保持浅色（规范允许），不需要补位
      }
    }
  }

  // ⑦ 掩码：只翻数据区。mask 0 的条件是 (row+col) 为偶数
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (isFunc[row][col]) continue;
      if ((row + col) % 2 === 0) modules[row][col] = !modules[row][col];
    }
  }

  return modules;
}

/** 组装码字：模式指示符 + 字符计数 + 数据 + 终止符 + 补齐 */
function qrMakeCodewords(bytes, version, ec) {
  const ccBits = qrCharCountBits(version);
  const capacityBits = qrDataCodewords(version, ec) * 8;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  push(0b0100, 4); // 模式指示符：0100 = 8 bit 字节模式
  push(bytes.length, ccBits);
  for (const b of bytes) push(b, 8);

  // 终止符最多 4 个 0；空间不够就少写几个（标准允许）
  const term = Math.min(4, capacityBits - bits.length);
  push(0, term);
  while (bits.length % 8 !== 0) bits.push(0); // 补齐到字节边界

  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataCw.push(v);
  }
  // 剩余容量用 0xEC / 0x11 交替填满：这两个是标准指定的填充码字
  for (let i = 0; dataCw.length < capacityBits / 8; i++) {
    dataCw.push(i % 2 === 0 ? 0xec : 0x11);
  }
  return dataCw;
}

/** 纯函数核心：给文本和 EC 等级，出模块矩阵 */
function qrEncodeCore(text, ec) {
  const bytes = new TextEncoder().encode(text);

  // 选最小的能装下的版本；1-10 都装不下就如实报错，不静默截断
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const usableBits = qrDataCodewords(v, ec) * 8 - 4 - qrCharCountBits(v);
    if (bytes.length * 8 <= usableBits) {
      version = v;
      break;
    }
  }
  if (!version) return null;

  const dataCw = qrMakeCodewords(bytes, version, ec);
  const spec = QR_BLOCK_TABLE[version - 1][ec];
  const allCw = qrInterleave(dataCw, spec);
  const mask = 0; // 固定 mask 0：可复现优先，牺牲一点点掩码评分
  const modules = qrBuildMatrix(version, ec, allCw, mask);

  return { version, ec, mask, size: modules.length, modules };
}

/** 渲染成终端可看的 ASCII：一个模块两字符宽，四周留 4 模块静默区 */
function qrToAscii(modules) {
  const size = modules.length;
  const q = 4;
  const lines = [];
  for (let r = -q; r < size + q; r++) {
    let line = "";
    for (let c = -q; c < size + q; c++) {
      const dark = r >= 0 && r < size && c >= 0 && c < size && modules[r][c];
      line += dark ? "██" : "  ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * 渲染成 SVG：一条 path 拼所有深色模块，坐标直接用模块整数，配合 crispEdges 不糊边。
 * 颜色用 currentColor，跟随宿主主题，不写死 #000（深色面板下也能看）。
 */
function qrToSvg(modules) {
  const size = modules.length;
  const q = 4;
  const n = size + q * 2;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" fill="currentColor"><path d="${d}"/></svg>`;
}

/**
 * run({ text, ec })
 *   text 字符串（必填）
 *   ec   "L" | "M" | "Q" | "H"，默认 "M"；非法值一律按 M 处理
 * 返回 { ok:true, version, ec, size, modules, ascii, svg, mask:0 }
 */
function runQrEncode(args = {}) {
  const text = args && args.text;
  if (typeof text !== "string") return { ok: false, error: "text-required" };
  const ec = ["L", "M", "Q", "H"].includes(args.ec) ? args.ec : "M";

  const core = qrEncodeCore(text, ec);
  if (!core) return { ok: false, error: "too-long" };

  return {
    ok: true,
    version: core.version,
    ec: core.ec,
    size: core.size,
    modules: core.modules,
    ascii: qrToAscii(core.modules),
    svg: qrToSvg(core.modules),
    mask: core.mask,
  };
}

/* ------------------------------------------------------------------ *
 * 插件目录
 * ------------------------------------------------------------------ */

export const BUILTIN_PLUGINS = [
  {
    id: "regex-pipeline",
    name: "正则流水线",
    brief: "按顺序执行多条正则替换，坏规则只跳过不中断",
    level: "S",
    inputs: ["text", "rules"],
    outputs: ["text", "hits"],
    run: runRegexPipeline,
  },
  {
    id: "qr-encode",
    name: "二维码生成",
    brief: "把短文本编成 QR 码矩阵，附 ASCII 与 SVG 两种渲染",
    level: "S",
    inputs: ["text", "ec"],
    outputs: ["modules", "ascii", "svg"],
    run: runQrEncode,
  },
];

/* ------------------------------------------------------------------ *
 * Host
 * ------------------------------------------------------------------ */

/**
 * @param {{ now?: () => number }} opts now 可注入，便于测试里得到确定的 lastAt / ms
 */
export function createPluginHost(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const artifactGate = opts.artifactGate || createArtifactGate({
    epochProvider: typeof opts.epochProvider === "function" ? opts.epochProvider : null,
  });

  const entries = new Map(); // id -> { plugin, builtin }
  const builtinIds = new Set();
  let runs = 0;
  let failed = 0;
  const byId = Object.create(null);
  let lastAt = null;

  for (const p of BUILTIN_PLUGINS) {
    entries.set(p.id, { plugin: p, builtin: true });
    builtinIds.add(p.id);
  }

  /* 归一化插件元信息：契约里这些字段只作文档用途，缺了也不该让注册失败 */
  function normalize(plugin) {
    return {
      id: plugin.id,
      name: typeof plugin.name === "string" && plugin.name ? plugin.name : plugin.id,
      brief: typeof plugin.brief === "string" ? plugin.brief : "",
      level: plugin.level,
      inputs: Array.isArray(plugin.inputs) ? plugin.inputs.filter((x) => typeof x === "string") : [],
      outputs: Array.isArray(plugin.outputs) ? plugin.outputs.filter((x) => typeof x === "string") : [],
      run: plugin.run,
      /* 跨生态摄入时由 pluginEcosystem 盖上：executable / declarative / descriptor。
         内置插件没有这个字段（它们天然可执行），列表侧按 builtin 兜底。 */
      fidelity: typeof plugin.fidelity === "string" ? plugin.fidelity : "",
    };
  }

  function register(plugin) {
    if (!plugin || typeof plugin !== "object") return { ok: false, error: "bad-plugin" };
    if (typeof plugin.id !== "string" || !ID_RE.test(plugin.id)) return { ok: false, error: "bad-id" };
    if (typeof plugin.run !== "function") return { ok: false, error: "bad-run" };
    if (!LEVELS.has(plugin.level)) return { ok: false, error: "bad-level" };
    if (entries.has(plugin.id)) return { ok: false, error: "duplicate-id" };

    /* 生成物 / 外部导入：三段式声明式验收（做什么 / 入口在哪 / 如何验收）。
     * 闸门拒绝时绝不进注册表 —— 尤其 api_call_register 与 restart-required，
     * 前者是硬红线，后者只是「配置已保存未激活」，不能算安装成功。 */
    if (plugin.origin) {
      const v = artifactGate.validate(plugin, { approvedBy: plugin.approvedBy || "" });
      if (!v.ok) return { ok: false, error: `artifact-gate:${v.code}`, gate: v };
    }

    const p = normalize(plugin);
    entries.set(p.id, { plugin: p, builtin: false });
    return { ok: true, plugin: { id: p.id, name: p.name, level: p.level } };
  }

  function unregister(id) {
    // 内置插件是随包发布的基线能力，允许注销会让「控制台有哪些工具」变得不可预期
    if (builtinIds.has(id)) return { ok: false, error: "builtin" };
    return { ok: true, removed: entries.delete(id) };
  }

  function list() {
    const plugins = [];
    for (const [id, e] of entries) {
      plugins.push({
        id,
        name: e.plugin.name,
        brief: e.plugin.brief,
        level: e.plugin.level,
        inputs: [...e.plugin.inputs],
        outputs: [...e.plugin.outputs],
        builtin: e.builtin,
        fidelity: e.builtin ? "executable" : (e.plugin.fidelity || ""),
      });
    }
    return { ok: true, plugins };
  }

  /* 收尾判定只写一处：同步与异步两条路径必须落在同一套结论上，否则会漂移 */
  function finish(id, result, t0) {
    const ms = now() - t0;
    lastAt = now();
    if (!result || result.ok !== true) {
      failed++;
      return { ok: false, pluginId: id, error: (result && result.error) || "run-failed" };
    }
    return { ok: true, pluginId: id, ms, result };
  }

  function failedWith(id, e) {
    failed++;
    lastAt = now();
    return { ok: false, pluginId: id, error: String((e && e.message) || e || "run-threw") };
  }

  /**
   * 纯函数插件同步返回结果；异步插件（MCP 网关等）返回 Promise。
   * 旧实现只看同一次调用的返回值，Promise 会被当成「没有 ok:true」判成 run-failed，
   * 异步能力因此永远装得上、跑不动。现在：同步插件照旧同步返回（老调用方零改动），
   * 异步插件返回可 await 的 Promise —— 调用方 await 一次即可两种通吃。
   */
  function run(id, args) {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: "unknown-plugin" };

    runs++;
    byId[id] = (byId[id] || 0) + 1;
    const t0 = now();

    let result;
    try {
      result = entry.plugin.run(args === undefined ? {} : args);
    } catch (e) {
      // 插件抛异常一律吞成结构化失败：Host 是长驻进程的边界，不能让它炸出去
      return failedWith(id, e);
    }

    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(
        (v) => finish(id, v, t0),
        (e) => failedWith(id, e),
      );
    }
    return finish(id, result, t0);
  }

  function stats() {
    return {
      ok: true,
      count: entries.size,
      runs,
      failed,
      byId: { ...byId },
      lastAt,
    };
  }

  return { register, unregister, list, run, stats };
}
