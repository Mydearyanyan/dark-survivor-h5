// 生成动画素材总览拼板：每角色展示 idle正面/run正面/attack正面/hurt1/hurt4 五个关键帧
const fs = require('fs'), zlib = require('zlib'), path = require('path');
function readPNG(file) { const b = fs.readFileSync(file); let p = 8, w, h, ct, idat = []; while (p < b.length) { const l = b.readUInt32BE(p), t = b.slice(p + 4, p + 8).toString(), d = b.slice(p + 8, p + 8 + l); if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (t === 'IDAT') idat.push(d); p += 12 + l; } const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, o = Buffer.alloc(h * st); for (let y = 0; y < h; y++) { const ft = raw[y * (st + 1)]; for (let x = 0; x < st; x++) { const c = raw[y * (st + 1) + 1 + x], a = x >= bpp ? o[y * st + x - bpp] : 0, bb = y > 0 ? o[(y - 1) * st + x] : 0, cc = (x >= bpp && y > 0) ? o[(y - 1) * st + x - bpp] : 0; let v; if (ft === 0) v = c; else if (ft === 1) v = c + a; else if (ft === 2) v = c + bb; else if (ft === 3) v = c + Math.floor((a + bb) / 2); else { const pp = a + bb - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - cc); v = c + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : cc); } o[y * st + x] = v & 255; } } const rgba = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = o[i * bpp]; rgba[i * 4 + 1] = o[i * bpp + 1]; rgba[i * 4 + 2] = o[i * bpp + 2]; rgba[i * 4 + 3] = bpp === 4 ? o[i * bpp + 3] : 255; } return { w, h, data: rgba }; }
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function writePNG(f, w, h, rgba) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const st = w * 4, raw = Buffer.alloc(h * (st + 1)); for (let y = 0; y < h; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, (y + 1) * st); fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])); }

const names = ['hero_xiaopangdun','hero_xueba','hero_tiyuweiyan','hero_jilinggui','hero_banhua','mob_tiaodanxuesheng','mob_lurenjia','mob_fantangdama','mob_laoshi','mob_tiyusheng','mob_xiaopihai','mob_baoan','boss_banzhuren','boss_jiaodaozhuren'];
const frameStates = ['idle','run','attack','hurt1','hurt4'];
const frontDir = n => n.startsWith('hero_') ? 'down' : 'downright';
const ANIM = path.join(__dirname, '..', 'assets', 'anim');
const CW = 130, CH = 150, PAD = 4;
const W = frameStates.length * (CW + PAD) + PAD, H = names.length * (CH + PAD) + PAD;
const canvas = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, c = ((Math.floor(x/14)+Math.floor(y/14))%2)?38:28; canvas[i]=c; canvas[i+1]=c; canvas[i+2]=c+5; canvas[i+3]=255; }
names.forEach((name, ri) => frameStates.forEach((st, ci) => {
  const f = path.join(ANIM, name, `${st}_${frontDir(name)}.png`);
  if (!fs.existsSync(f)) return;
  const im = readPNG(f), scale = Math.min((CW-6)/im.w, (CH-6)/im.h), dw = Math.round(im.w*scale), dh = Math.round(im.h*scale);
  const ox = PAD + ci*(CW+PAD) + Math.floor((CW-dw)/2), oy = PAD + ri*(CH+PAD) + Math.floor((CH-dh)/2);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const sx=Math.floor(x/scale), sy=Math.floor(y/scale), si=(sy*im.w+sx)*4; if (im.data[si+3]<10) continue; const dx=ox+x, dy=oy+y; if(dx<0||dx>=W||dy<0||dy>=H) continue; const di=(dy*W+dx)*4; canvas[di]=im.data[si]; canvas[di+1]=im.data[si+1]; canvas[di+2]=im.data[si+2]; canvas[di+3]=255; }
}));
writePNG(path.join(__dirname, '..', 'assets', 'anim_overview.png'), W, H, canvas);
console.log('overview', W+'x'+H, 'cols: idle/run/attack/hurt1/hurt4');
