// 把所有透明素材拼成一张预览图，深色棋盘底，检查整体效果。
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

const files = [
  'hero_xiaopangdun.png', 'hero_xueba.png', 'hero_tiyuweiyan.png', 'hero_jilinggui.png', 'hero_banhua.png',
  'mob_tiaodanxuesheng.png', 'mob_lurenjia.png', 'mob_fantangdama.png', 'mob_laoshi.png', 'mob_tiyusheng.png', 'mob_xiaopihai.png', 'mob_baoan.png',
  'boss_banzhuren.png', 'boss_jiaodaozhuren.png',
];
const base = path.join(__dirname, '..', 'assets');
const CELL = 200, COLS = 5, ROWS = 3, PAD = 8;
const W = COLS * (CELL + PAD) + PAD, H = ROWS * (CELL + PAD + 22) + PAD;
const canvas = Buffer.alloc(W * H * 4);
// 深色棋盘底
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4; const c = ((Math.floor(x / 20) + Math.floor(y / 20)) % 2) ? 42 : 30;
  canvas[i] = c; canvas[i + 1] = c; canvas[i + 2] = c + 6; canvas[i + 3] = 255;
}
files.forEach((f, idx) => {
  const file = f.startsWith('hero_xiaopangdun') ? path.join(base, f) : path.join(base, 'sprites', f);
  const im = readPNG(file);
  const scale = Math.min((CELL - 10) / im.w, CELL / im.h);
  const dw = Math.round(im.w * scale), dh = Math.round(im.h * scale);
  const col = idx % COLS, row = Math.floor(idx / COLS);
  const cx = PAD + col * (CELL + PAD), cy = PAD + row * (CELL + PAD + 22);
  const ox = cx + Math.floor((CELL - dw) / 2), oy = cy + Math.floor((CELL - dh) / 2);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx = Math.floor(x / scale), sy = Math.floor(y / scale), si = (sy * im.w + sx) * 4;
    const a = im.data[si + 3]; if (a < 10) continue;
    const dx = ox + x, dy = oy + y; if (dx < 0 || dx >= W || dy < 0 || dy >= H) continue;
    const di = (dy * W + dx) * 4;
    canvas[di] = im.data[si]; canvas[di + 1] = im.data[si + 1]; canvas[di + 2] = im.data[si + 2]; canvas[di + 3] = 255;
  }
});
writePNG(path.join(base, 'sprites_contact_sheet.png'), W, H, canvas);
console.log('contact sheet:', W + 'x' + H);
