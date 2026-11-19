// 纯代码抠图：flood-fill 删除与边缘连通的背景（白底/浅灰阴影/水印），
// 保留被黑色描边包围的角色主体。零依赖、零积分。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function readPNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w, h, bd, ct, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.slice(p + 4, p + 8).toString();
    const d = b.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const bb = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (ft === 0) v = cur; else if (ft === 1) v = cur + a; else if (ft === 2) v = cur + bb;
      else if (ft === 3) v = cur + Math.floor((a + bb) / 2);
      else { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c); }
      out[y * stride + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = out[i * bpp]; rgba[i * 4 + 1] = out[i * bpp + 1];
    rgba[i * 4 + 2] = out[i * bpp + 2]; rgba[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3] : 255;
  }
  return { w, h, data: rgba };
}

function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const td = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0); return Buffer.concat([l, td, c]); }
function writePNG(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); raw[y * (stride + 1)] = 0; }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// 判断是否为背景色：接近纯白 或 浅灰(阴影/水印)。
// 关键：必须是"低饱和度的亮色"，彩色的角色主体不会被误判。
function isBg(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx - mn;                       // 饱和度差
  const lum = (r + g + b) / 3;
  // 近白：三通道都很高
  if (r > 232 && g > 232 && b > 232) return true;
  // 浅灰（地面阴影/水印）：低饱和且较亮，lum>150 才删，避免删掉深色描边
  if (sat < 28 && lum > 150) return true;
  return false;
}

function matting(file, outFile, isMonster) {
  const { w, h, data } = readPNG(file);
  const visited = new Uint8Array(w * h);
  const stack = [];
  // 种子策略：顶部整行 + 左右整列都作为背景种子；
  // 底部只在两侧各25%区域下种子，避免从角色脚下把浅色鞋底当背景啃掉。
  for (let x = 0; x < w; x++) stack.push(x); // 顶行
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); } // 左右列
  const footSafe = Math.floor(w * 0.25);
  for (let x = 0; x < w; x++) if (x < footSafe || x > w - footSafe) stack.push((h - 1) * w + x); // 底行两侧
  let removed = 0;
  while (stack.length) {
    const idx = stack.pop();
    if (visited[idx]) continue;
    visited[idx] = 1;
    const i = idx * 4;
    if (!isBg(data[i], data[i + 1], data[i + 2])) continue;
    data[i + 3] = 0; // 透明
    removed++;
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }
  // 怪物专属：清除两腿间被描边包围的纯白三角（flood-fill 到不了的内部孤岛）。
  // 主角不处理，因为白衬衫含大量纯白像素，误删会破坏衣服。
  if (isMonster) {
    // 饭堂大妈穿围裙、BOSS有浅色，跳过全图浅色清理以免误伤衣物
    const skip = /fantangdama/.test(path.basename(outFile));
    if (!skip) {
      for (let y = Math.floor(h * 0.72); y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          if (data[p + 3] === 0) continue;
          const r = data[p], g = data[p + 1], b = data[p + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          // 腿部区域的浅灰白三角（背景），删除
          if (mn > 198 && mx - mn < 32) { data[p + 3] = 0; removed++; }
        }
      }
    }
  }
  writePNG(outFile, w, h, data);
  return { w, h, removed, pct: (removed / (w * h) * 100).toFixed(1) };
}

const rawDir = path.join(__dirname, '..', 'assets', 'sprites_raw');
const outDir = path.join(__dirname, '..', 'assets', 'sprites');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(rawDir).filter(x => x.endsWith('.png'))) {
  const isMonster = f.startsWith('mob_') || f.startsWith('boss_');
  const r = matting(path.join(rawDir, f), path.join(outDir, f), isMonster);
  console.log(f, `${r.w}x${r.h}`, `removed ${r.pct}%`);
}
console.log('DONE');
