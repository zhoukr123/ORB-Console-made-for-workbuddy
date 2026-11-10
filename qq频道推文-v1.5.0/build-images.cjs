/* 生成 QQ 频道推文配图：中文封面 + 四主题拼图 + 三张真实界面截图。
 * 运行：node qq频道推文-v1.5.0/build-images.cjs
 * 依赖项目自带的 sharp（orb/node_modules/sharp），不额外装包。 */
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('../orb/node_modules/sharp');

const HERE = __dirname;
const IMG = path.join(HERE, 'images');
const SHOTS = path.join(HERE, '..', 'docs', 'shots');

async function main() {
  // 1. 中文封面（SVG 渲染，文字不会像 AI 生成图那样乱码）
  await sharp(path.join(IMG, 'cover.svg')).png().toFile(path.join(IMG, '01-封面.png'));

  // 2. 四套主题拼图：取每张上半部分，2x2
  const themes = ['theme-deepspace.png', 'theme-daylight.png', 'theme-aurora.png', 'theme-custom.png'];
  const W = 400, H = 400, GAP = 16, PAD = 24;
  const tiles = [];
  for (const f of themes) {
    tiles.push(await sharp(path.join(SHOTS, f))
      .resize(W, H, { fit: 'cover', position: 'top' })
      .png().toBuffer());
  }
  const composites = tiles.map((input, i) => ({
    input,
    left: PAD + (i % 2) * (W + GAP),
    top: PAD + Math.floor(i / 2) * (H + GAP),
  }));
  await sharp({
    create: {
      width: PAD * 2 + W * 2 + GAP,
      height: PAD * 2 + H * 2 + GAP,
      channels: 4,
      background: '#0B0E1A',
    },
  }).composite(composites).png().toFile(path.join(IMG, '05-四套主题.png'));

  // 3. 真实界面截图（原样复制，不做二次压缩）
  const copies = [
    ['theme-deepspace.png', '02-主界面-深空.png'],
    ['set-t1-plugins.png', '03-插件生态.png'],
    ['set-t1-auto.png', '04-自动化.png'],
  ];
  for (const [src, dst] of copies) {
    fs.copyFileSync(path.join(SHOTS, src), path.join(IMG, dst));
  }

  for (const f of fs.readdirSync(IMG).filter((n) => n.endsWith('.png')).sort()) {
    const m = await sharp(path.join(IMG, f)).metadata();
    console.log(`  ${f}  ${m.width}x${m.height}  ${(fs.statSync(path.join(IMG, f)).size / 1024).toFixed(0)}KB`);
  }
  console.log('IMAGES_OK');
}

main().catch((e) => { console.error('IMAGES_FAIL', e); process.exit(1); });
