// 精灵图集裁切 + 抠图 + 拼板预览（零依赖、零积分）
const fs = require('fs'), zlib = require('zlib'), path = require('path');

function readPNG(file) {
  const b = fs.readFileSync(file); let p = 8, w, h, ct, idat = [];
  while (p < b.length) { const l = b.readUInt32BE(p), t = b.slice(p + 4, p + 8).toString(), d = b.slice(p + 8, p + 8 + l); if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (t === 'IDAT') idat.push(d); p += 12 + l; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, o = Buffer.alloc(h * st);
  for (let y = 0; y < h; y++) { const ft = raw[y * (st + 1)]; for (let x = 0; x < st; x++) { const c = raw[y * (st + 1) + 1 + x], a = x >= bpp ? o[y * st + x - bpp] : 0, bb = y > 0 ? o[(y - 1) * st + x] : 0, cc = (x >= bpp && y > 0) ? o[(y - 1) * st + x - bpp] : 0; let v; if (ft === 0) v = c; else if (ft === 1) v = c + a; else if (ft === 2) v = c + bb; else if (ft === 3) v = c + Math.floor((a + bb) / 2); else { const pp = a + bb - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - cc); v = c + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : cc); } o[y * st + x] = v & 255; } }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = o[i * bpp]; rgba[i * 4 + 1] = o[i * bpp + 1]; rgba[i * 4 + 2] = o[i * bpp + 2]; rgba[i * 4 + 3] = bpp === 4 ? o[i * bpp + 3] : 255; }
  return { w, h, data: rgba };
}
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function writePNG(f, w, h, rgba) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const st = w * 4, raw = Buffer.alloc(h * (st + 1)); for (let y = 0; y < h; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, (y + 1) * st); fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])); }

function isBg(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn, lum = (r + g + b) / 3;
  if (r > 224 && g > 224 && b > 224) return true;
  if (sat < 26 && lum > 158) return true;
  return false;
}
// flood-fill 抠掉与边缘连通的浅色背景
function matting(im) {
  const { w, h, data } = im, visited = new Uint8Array(w * h), stack = [];
  for (let x = 0; x < w; x++) stack.push(x);
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
  const foot = Math.floor(w * 0.22);
  for (let x = 0; x < w; x++) if (x < foot || x > w - foot) stack.push((h - 1) * w + x);
  while (stack.length) {
    const idx = stack.pop(); if (visited[idx]) continue; visited[idx] = 1;
    const i = idx * 4; if (!isBg(data[i], data[i + 1], data[i + 2])) continue;
    data[i + 3] = 0;
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0) stack.push(idx - 1); if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w); if (y < h - 1) stack.push(idx + w);
  }
  // 清腿部浅色三角（下半身纯浅灰），眼泪(蓝)保留
  for (let y = Math.floor(h * 0.7); y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mn > 200 && mx - mn < 30) data[i + 3] = 0;
  }
  return im;
}

function splitSheet(file, cols, rows, prefix, outDir) {
  const im = readPNG(file), gw = im.w / cols, gh = im.h / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.round(c * gw) + 9, y0 = Math.round(r * gh) + 9;
    const x1 = Math.round((c + 1) * gw) - 9, y1 = Math.round((r + 1) * gh) - 9;
    const w = x1 - x0, h = y1 - y0, data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) im.data.copy(data, y * w * 4, ((y0 + y) * im.w + x0) * 4, ((y0 + y) * im.w + x1) * 4);
    const cell = matting({ w, h, data });
    cells.push({ r, c, ...cell });
    writePNG(path.join(outDir, `${prefix}_r${r}c${c}.png`), w, h, data);
  }
  // 拼板：深色棋盘底
  const S = 150, PAD = 6, CW = S + PAD, CH = S + PAD;
  const W = cols * CW + PAD, H = rows * CH + PAD, canvas = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, col = ((Math.floor(x / 16) + Math.floor(y / 16)) % 2) ? 40 : 28; canvas[i] = col; canvas[i + 1] = col; canvas[i + 2] = col + 5; canvas[i + 3] = 255; }
  for (const cell of cells) {
    const scale = Math.min(S / cell.w, S / cell.h), dw = Math.round(cell.w * scale), dh = Math.round(cell.h * scale);
    const ox = PAD + cell.c * CW + Math.floor((S - dw) / 2), oy = PAD + cell.r * CH + Math.floor((S - dh) / 2);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const sx = Math.floor(x / scale), sy = Math.floor(y / scale), si = (sy * cell.w + sx) * 4;
      if (cell.data[si + 3] < 10) continue;
      const dx = ox + x, dy = oy + y; if (dx < 0 || dx >= W || dy < 0 || dy >= H) continue;
      const di = (dy * W + dx) * 4; canvas[di] = cell.data[si]; canvas[di + 1] = cell.data[si + 1]; canvas[di + 2] = cell.data[si + 2]; canvas[di + 3] = 255;
    }
  }
  const out = path.join(outDir, `${prefix}_preview.png`); writePNG(out, W, H, canvas);
  console.log(prefix, cols + 'x' + rows, 'cells=' + cells.length, 'preview=' + W + 'x' + H);
}

const base = path.join(__dirname, '..', 'assets'), sheets = path.join(base, 'sheets'), out = path.join(sheets, 'split');
fs.mkdirSync(out, { recursive: true });
splitSheet(path.join(sheets, '一张游戏角色精灵图集_sprite_sheet__整齐排列的_2026-11-19T06-55-45.png'), 6, 4, 'hero_xiaopangdun', out);
splitSheet(path.join(sheets, '一张游戏怪物精灵图集_sprite_sheet__整齐排列的_2026-11-19T06-56-06.png'), 4, 4, 'mob_tiaodan', out);
console.log('DONE');
