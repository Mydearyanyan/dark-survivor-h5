// 最终动画素材构建：图集映射 → 裁切 → 抠图 → 程序镜像生成方向 → 输出。
// 零依赖、零积分。输出 assets/anim/<角色>/<状态>_<方向>.png
const fs = require('fs'), zlib = require('zlib'), path = require('path');

const SHEETS = path.join(__dirname, '..', 'assets', 'sheets');
const OUT = path.join(__dirname, '..', 'assets', 'anim');

// ============ PNG 编解码 ============
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

// ============ 抠图（flood-fill 去白底）============
function isBg(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return (r > 224 && g > 224 && b > 224) || ((mx - mn) < 26 && (r + g + b) / 3 > 158); }
function matting(im, isMonster) {
  const { w, h, data } = im, vis = new Uint8Array(w * h), st = [];
  for (let x = 0; x < w; x++) st.push(x);
  for (let y = 0; y < h; y++) { st.push(y * w); st.push(y * w + w - 1); }
  const foot = Math.floor(w * 0.22);
  for (let x = 0; x < w; x++) if (x < foot || x > w - foot) st.push((h - 1) * w + x);
  while (st.length) { const idx = st.pop(); if (vis[idx]) continue; vis[idx] = 1; const i = idx * 4; if (!isBg(data[i], data[i + 1], data[i + 2])) continue; data[i + 3] = 0; const x = idx % w, y = (idx / w) | 0; if (x > 0) st.push(idx - 1); if (x < w - 1) st.push(idx + 1); if (y > 0) st.push(idx - w); if (y < h - 1) st.push(idx + w); }
  // 腿部浅色三角 + 底部白边清理（保留蓝色眼泪：蓝色饱和度高不会被删）
  for (let y = Math.floor(h * 0.62); y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (!data[i + 3]) continue; const r = data[i], g = data[i + 1], b = data[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mn > 188 && mx - mn < 34) data[i + 3] = 0; }
  // 怪物专属：清除被轮廓围住的白色孤岛（怪物是暗黑配色，身上无纯白；灰白围裙/发网亮度较低会保留）
  if (isMonster) {
    for (let i = 0; i < w * h; i++) { const p = i * 4; if (!data[p + 3]) continue; const r = data[p], g = data[p + 1], b = data[p + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mn > 216 && mx - mn < 22) data[p + 3] = 0; }
  }
  // 裁到内容包围盒（留2px边）
  let minx = w, miny = h, maxx = 0, maxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 20) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  if (minx > maxx) return im;
  minx = Math.max(0, minx - 2); miny = Math.max(0, miny - 2); maxx = Math.min(w - 1, maxx + 2); maxy = Math.min(h - 1, maxy + 2);
  const cw = maxx - minx + 1, ch = maxy - miny + 1, out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) data.copy(out, y * cw * 4, ((miny + y) * w + minx) * 4, ((miny + y) * w + minx + cw) * 4);
  return { w: cw, h: ch, data: out };
}

// ============ 方向生成（镜像 + 倾斜模拟）============
function flipH(im) { const { w, h, data } = im, out = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const si = (y * w + (w - 1 - x)) * 4, di = (y * w + x) * 4; data.copy(out, di, si, si + 4); } return { w, h, data: out }; }
// 水平压缩模拟侧身（scaleX，居中），斜向再叠加轻微垂直偏移
function skew(im, scaleX) { const { w, h, data } = im, nw = Math.max(1, Math.round(w * scaleX)), out = Buffer.alloc(nw * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < nw; x++) { const sx = Math.min(w - 1, Math.floor(x / scaleX)), si = (y * w + sx) * 4, di = (y * nw + x) * 4; data.copy(out, di, si, si + 4); } return { w: nw, h, data: out }; }
// 拼到统一画布（居中），保证同状态各方向尺寸一致
function padTo(im, W, H) { const out = Buffer.alloc(W * H * 4), ox = Math.floor((W - im.w) / 2), oy = H - im.h; for (let y = 0; y < im.h; y++) im.data.copy(out, ((oy + y) * W + ox) * 4, y * im.w * 4, (y + 1) * im.w * 4); return { w: W, h: H, data: out }; }

// 主角8方向：down/up/left/right/downleft/downright/upleft/upright
function heroDirections(base) {
  const W = base.w, H = base.h, mir = flipH(base);
  const side = skew(base, 0.78), sideMir = flipH(side);
  return {
    down: padTo(base, W, H),
    up: padTo(skew(flipH(base), 0.9), W, H),
    left: padTo(side, W, H),
    right: padTo(sideMir, W, H),
    downleft: padTo(skew(base, 0.88), W, H),
    downright: padTo(flipH(skew(base, 0.88)), W, H),
    upleft: padTo(side, W, H),
    upright: padTo(sideMir, W, H),
  };
}
// 怪物4方向：左上/左下/右上/右下（用正面+镜像+压缩近似）
function mobDirections(base) {
  const W = base.w, H = base.h, mir = flipH(base);
  const side = skew(base, 0.82), sideMir = flipH(side);
  return {
    upleft: padTo(side, W, H),
    upright: padTo(sideMir, W, H),
    downleft: padTo(skew(base, 0.9), W, H),
    downright: padTo(flipH(skew(base, 0.9)), W, H),
  };
}

// ============ 角色→图集映射 ============
// 每个角色: { sheet3: 三状态图集文件, sheetHit: 受击图集文件, kind: hero|mob|boss }
const M = {
  hero_xiaopangdun: { s3: '一张游戏角色精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-21-29.png', hit: '一张游戏角色受击动画精灵图集_极其夸张的受击表现_参考经典街_2026-11-19T06-59-09.png', kind: 'hero' },
  hero_xueba:        { s3: '一张游戏角色精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-01-58.png', hit: '一张游戏角色受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-07-47.png', kind: 'hero' },
  hero_tiyuweiyan:   { s3: '一张游戏角色精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-04-59.png', hit: '一张游戏角色受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-08-01.png', kind: 'hero' },
  hero_jilinggui:    { s3: '一张游戏角色精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-05-12.png', hit: '一张游戏角色受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-11-06.png', kind: 'hero' },
  hero_banhua:       { s3: '一张游戏角色精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-05-28.png', hit: '一张游戏角色受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-11-24.png', kind: 'hero' },
  mob_tiaodanxuesheng: { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-13-05.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-18-25.png', kind: 'mob' },
  mob_lurenjia:        { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-16-25.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-18-36.png', kind: 'mob' },
  mob_fantangdama:     { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-17-05.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-18-47.png', kind: 'mob' },
  mob_laoshi:          { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-17-14.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-18-57.png', kind: 'mob' },
  mob_tiyusheng:       { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-17-39.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-19-26.png', kind: 'mob' },
  mob_xiaopihai:       { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-17-49.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-19-36.png', kind: 'mob' },
  mob_baoan:           { s3: '一张游戏怪物精灵图集_sprite_sheet__整齐的_3_2026-11-19T07-17-58.png', hit: '一张游戏怪物受击动画精灵图集_极其夸张搞笑的受击演出_参考__2026-11-19T07-19-48.png', kind: 'mob' },
  boss_banzhuren:      { s3: '一张游戏BOSS精灵图集_sprite_sheet__整齐的_2026-11-19T07-20-20.png', hit: '一张游戏BOSS受击动画精灵图集_极其夸张搞笑的受击演出_参_2026-11-19T07-20-40.png', kind: 'mob' },
  boss_jiaodaozhuren:  { s3: '一张游戏BOSS精灵图集_sprite_sheet__整齐的_2026-11-19T07-20-31.png', hit: '一张游戏BOSS受击动画精灵图集_极其夸张搞笑的受击演出_参_2026-11-19T07-20-55.png', kind: 'mob' },
};
const STATE3 = ['idle', 'run', 'attack']; // 三状态图集的三格

function cropCell(im, col, cols) { const gw = im.w / cols, x0 = Math.round(col * gw) + 8, x1 = Math.round((col + 1) * gw) - 8, y0 = 6, y1 = im.h - 6, w = x1 - x0, h = y1 - y0, data = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) im.data.copy(data, y * w * 4, ((y0 + y) * im.w + x0) * 4, ((y0 + y) * im.w + x1) * 4); return { w, h, data }; }

fs.mkdirSync(OUT, { recursive: true });
let totalFrames = 0;
for (const [name, cfg] of Object.entries(M)) {
  const dir = path.join(OUT, name); fs.mkdirSync(dir, { recursive: true });
  const sheet3 = readPNG(path.join(SHEETS, cfg.s3));
  const sheetHit = readPNG(path.join(SHEETS, cfg.hit));
  // 三状态各 1 帧
  const states = {};
  const isMonster = cfg.kind !== 'hero';
  STATE3.forEach((st, i) => { states[st] = [matting(cropCell(sheet3, i, 3), isMonster)]; });
  // 受击 4 帧
  states.hurt = [];
  for (let i = 0; i < 4; i++) states.hurt.push(matting(cropCell(sheetHit, i, 4), isMonster));
  // 生成方向并输出
  const dirs = cfg.kind === 'hero' ? heroDirections : mobDirections;
  for (const [st, frames] of Object.entries(states)) {
    frames.forEach((frame, fi) => {
      const framed = dirs(frame);
      for (const [d, dimg] of Object.entries(framed)) {
        const suffix = frames.length > 1 ? `${st}${fi + 1}` : st;
        writePNG(path.join(dir, `${suffix}_${d}.png`), dimg.w, dimg.h, dimg.data);
        totalFrames++;
      }
    });
  }
  console.log(name, cfg.kind, 'states=' + Object.keys(states).join('/'), 'hurtFrames=' + states.hurt.length);
}
console.log('TOTAL FRAMES:', totalFrames);
