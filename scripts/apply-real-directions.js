// 用 AI 生成的真方向图集替换主角的假方向帧（三状态 up/left/right + 斜向近似）。
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const DIRS = path.join(__dirname, '..', 'assets', 'sheets', 'dirs');
const ANIM = path.join(__dirname, '..', 'assets', 'anim');

function readPNG(file) { const b = fs.readFileSync(file); let p = 8, w, h, ct, idat = []; while (p < b.length) { const l = b.readUInt32BE(p), t = b.slice(p + 4, p + 8).toString(), d = b.slice(p + 8, p + 8 + l); if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (t === 'IDAT') idat.push(d); p += 12 + l; } const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, o = Buffer.alloc(h * st); for (let y = 0; y < h; y++) { const ft = raw[y * (st + 1)]; for (let x = 0; x < st; x++) { const c = raw[y * (st + 1) + 1 + x], a = x >= bpp ? o[y * st + x - bpp] : 0, bb = y > 0 ? o[(y - 1) * st + x] : 0, cc = (x >= bpp && y > 0) ? o[(y - 1) * st + x - bpp] : 0; let v; if (ft === 0) v = c; else if (ft === 1) v = c + a; else if (ft === 2) v = c + bb; else if (ft === 3) v = c + Math.floor((a + bb) / 2); else { const pp = a + bb - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - cc); v = c + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : cc); } o[y * st + x] = v & 255; } } const rgba = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = o[i * bpp]; rgba[i * 4 + 1] = o[i * bpp + 1]; rgba[i * 4 + 2] = o[i * bpp + 2]; rgba[i * 4 + 3] = bpp === 4 ? o[i * bpp + 3] : 255; } return { w, h, data: rgba }; }
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function writePNG(f, w, h, rgba) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const st = w * 4, raw = Buffer.alloc(h * (st + 1)); for (let y = 0; y < h; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, (y + 1) * st); fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])); }
function isBg(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return (r > 224 && g > 224 && b > 224) || ((mx - mn) < 26 && (r + g + b) / 3 > 158); }
function matting(im) {
  const { w, h, data } = im, vis = new Uint8Array(w * h), st = [];
  for (let x = 0; x < w; x++) st.push(x);
  for (let y = 0; y < h; y++) { st.push(y * w); st.push(y * w + w - 1); }
  const foot = Math.floor(w * 0.22);
  for (let x = 0; x < w; x++) if (x < foot || x > w - foot) st.push((h - 1) * w + x);
  while (st.length) { const idx = st.pop(); if (vis[idx]) continue; vis[idx] = 1; const i = idx * 4; if (!isBg(data[i], data[i + 1], data[i + 2])) continue; data[i + 3] = 0; const x = idx % w, y = (idx / w) | 0; if (x > 0) st.push(idx - 1); if (x < w - 1) st.push(idx + 1); if (y > 0) st.push(idx - w); if (y < h - 1) st.push(idx + w); }
  for (let y = Math.floor(h * 0.62); y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (!data[i + 3]) continue; const r = data[i], g = data[i + 1], b = data[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mn > 188 && mx - mn < 34) data[i + 3] = 0; }
  return im;
}
function cropCell(im, col, cols) { const gw = im.w / cols, x0 = Math.round(col * gw) + 8, x1 = Math.round((col + 1) * gw) - 8, y0 = 6, y1 = im.h - 6, w = x1 - x0, h = y1 - y0, data = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) im.data.copy(data, y * w * 4, ((y0 + y) * im.w + x0) * 4, ((y0 + y) * im.w + x1) * 4); return { w, h, data }; }
function flipH(im) { const { w, h, data } = im, out = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const si = (y * w + (w - 1 - x)) * 4, di = (y * w + x) * 4; data.copy(out, di, si, si + 4); } return { w, h, data: out }; }
function padTo(im, W, H) {
  const scale = Math.min(W / im.w, H / im.h, 1); // 只缩小不放大
  const nw = Math.max(1, Math.round(im.w * scale)), nh = Math.max(1, Math.round(im.h * scale));
  const out = Buffer.alloc(W * H * 4), ox = Math.floor((W - nw) / 2), oy = H - nh;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = Math.min(im.w - 1, Math.floor(x / scale)), sy = Math.min(im.h - 1, Math.floor(y / scale));
    const si = (sy * im.w + sx) * 4, di = ((oy + y) * W + ox + x) * 4;
    im.data.copy(out, di, si, si + 4);
  }
  return { w: W, h: H, data: out };
}

// 角色 → 三张方向图集（背/左/右）
const MAP = {
  hero_xiaopangdun: ['一张游戏角色背面视角精灵图集_sprite_sheet__整_2026-11-19T07-28-19.png','一张游戏角色左侧面视角精灵图集_sprite_sheet___2026-11-19T07-28-32.png','一张游戏角色右侧面视角精灵图集_sprite_sheet___2026-11-19T07-28-43.png'],
  hero_xueba:        ['一张像素游戏角色背面视角精灵图集_3列1行共3格_格子间粗白_2026-11-19T07-29-26.png','一张像素游戏角色左侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-29-37.png','一张像素游戏角色右侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-29-47.png'],
  hero_tiyuweiyan:   ['一张像素游戏角色背面视角精灵图集_3列1行共3格_格子间粗白_2026-11-19T07-30-15.png','一张像素游戏角色左侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-30-26.png','一张像素游戏角色右侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-30-38.png'],
  hero_jilinggui:    ['一张像素游戏角色背面视角精灵图集_3列1行共3格_格子间粗白_2026-11-19T07-31-07.png','一张像素游戏角色左侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-31-16.png','一张像素游戏角色右侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-31-25.png'],
  hero_banhua:       ['一张像素游戏角色背面视角精灵图集_3列1行共3格_格子间粗白_2026-11-19T07-31-53.png','一张像素游戏角色左侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-32-03.png','一张像素游戏角色右侧面视角精灵图集_3列1行共3格_格子间粗_2026-11-19T07-32-14.png'],
};
const STATES = ['idle', 'run', 'attack'];
// 方向集：up=真背面, left/right=真侧面, down=正面(保留原文件), 斜向=真方向近似
for (const [name, [backF, leftF, rightF]] of Object.entries(MAP)) {
  const back = matting(readPNG(path.join(DIRS, backF)));
  const left = matting(readPNG(path.join(DIRS, leftF)));
  const right = matting(readPNG(path.join(DIRS, rightF)));
  const dir = path.join(ANIM, name);
  // 取正面帧尺寸作为统一画布
  const front = readPNG(path.join(dir, 'idle_down.png'));
  const W = front.w, H = front.h;
  const dirFrames = {
    up: back, left, right,
    // 斜向用真左/右/背的近似：downleft≈left, downright≈right, upleft/upright≈back微缩
    downleft: left, downright: right, upleft: back, upright: flipH(back),
  };
  STATES.forEach((st, i) => {
    for (const [d, sheet] of Object.entries(dirFrames)) {
      const cell = cropCell(sheet, i, 3);
      const out = padTo(cell, W, H);
      writePNG(path.join(dir, `${st}_${d}.png`), W, H, out.data);
    }
  });
  console.log(name, '真方向替换完成 idle/run/attack × up/left/right/斜向');
}
console.log('DONE');
