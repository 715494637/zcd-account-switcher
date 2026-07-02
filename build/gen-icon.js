"use strict";
/**
 * 生成 desktop/assets/icon.ico
 * 色调：暖纸底 #f5f3ec，橄榄绿切换符 oklch(0.535 0.085 142) ≈ #4d7a52
 * 图标语义：两个反向箭头（切号 = 账号切换），极简圆角方块风格
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { default: pngToIco } = require("png-to-ico");

const OUT_DIR = path.join(__dirname, "..", "assets");
fs.mkdirSync(OUT_DIR, { recursive: true });

// SVG：256×256，圆角正方形背景 + 两条对向弧形箭头
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <!-- 背景：暖纸米白，大圆角 -->
  <rect width="256" height="256" rx="52" ry="52" fill="#f5f3ec"/>

  <!-- 切换图标：两个偏移的弧形箭头，橄榄绿 -->
  <!-- 上箭头：左→右弧，箭头朝右 -->
  <g fill="none" stroke="#4d7a52" stroke-width="16" stroke-linecap="round">
    <!-- 上弧：从左到右 -->
    <path d="M 72 112 C 72 76 184 76 184 112"/>
    <!-- 上箭头头 -->
    <polyline points="163,92 184,112 163,112" stroke-linejoin="round"/>
    <!-- 下弧：从右到左 -->
    <path d="M 184 144 C 184 180 72 180 72 144"/>
    <!-- 下箭头头 -->
    <polyline points="93,164 72,144 93,144" stroke-linejoin="round"/>
  </g>
</svg>`;

const svgPath = path.join(OUT_DIR, "icon.svg");
const pngPath = path.join(OUT_DIR, "icon-256.png");
const icoPath = path.join(OUT_DIR, "icon.ico");

fs.writeFileSync(svgPath, svg, "utf8");
console.log("✓ SVG written:", svgPath);

// SVG → PNG 256×256（透明→暖白背景已内嵌在 SVG 里）
sharp(Buffer.from(svg))
  .resize(256, 256)
  .png()
  .toFile(pngPath)
  .then(async () => {
    console.log("✓ PNG written:", pngPath);
    // PNG → ICO（multi-res: 16/32/48/64/128/256）
    // png-to-ico 接受单张 PNG，内部会生成多尺寸
    const buf = await pngToIco([pngPath]);
    fs.writeFileSync(icoPath, buf);
    console.log("✓ ICO written:", icoPath, `(${(buf.length/1024).toFixed(1)} KB)`);
  })
  .catch((e) => { console.error("✗ 图标生成失败:", e.message); process.exit(1); });
