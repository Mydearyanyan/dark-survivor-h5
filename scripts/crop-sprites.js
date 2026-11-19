// 从总览图裁切出单个角色格子，输出为独立 PNG。
// 零依赖：用 Node 内置 zlib 手写 PNG 编解码。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function readPNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w, h, bd, ct, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.slice(p + 4, p + 8).toString();
    const d = b.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG bd=${bd} ct=${ct}`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const bb = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (ft === 0) v = cur;
      else if (ft === 1) v = cur + a;
      else if (ft === 2) v = cur + bb;
      else if (ft === 3) v = cur + Math.floor((a + bb) / 2);
      else if (ft === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
      } else throw new Error('filter ' + ft);
      out[y * stride + x] = v & 255;
    }
  }
  // 统一转 RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = out[i * bpp];
    rgba[i * 4 + 1] = out[i * bpp + 1];
    rgba[i * 4 + 2] = out[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3] : 255;
  }
  return { w, h, data: rgba };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    raw[y * (stride + 1)] = 0;
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const buf = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, buf);
}

// 裁切一格：src 图, 行列, 行列数, 四周内缩像素(去网格线)
function crop(src, row, col, rows, cols, inset, outFile) {
  const gw = src.w / cols, gh = src.h / rows;
  const x0 = Math.round(col * gw) + inset.x;
  const y0 = Math.round(row * gh) + inset.y;
  const x1 = Math.round((col + 1) * gw) - inset.x;
  const y1 = Math.round((row + 1) * gh) - inset.y;
  const w = x1 - x0, h = y1 - y0;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    src.data.copy(data, y * w * 4, ((y0 + y) * src.w + x0) * 4, ((y0 + y) * src.w + x1) * 4);
  }
  writePNG(outFile, w, h, data);
  return { w, h, file: outFile };
}

const assets = path.join(__dirname, '..', 'assets');
const outDir = path.join(__dirname, '..', 'assets', 'sprites_raw');
fs.mkdirSync(outDir, { recursive: true });

// 图1：14角色总览 1536x1024，3行5列。取第1行主角（第2~5格：学霸/体育委员/机灵鬼/班花）
const heroes = readPNG(path.join(assets, '一张游戏角色设定总览图_严格参考输入图片的Q版萌系像素美术风_2026-11-19T06-29-39.png'));
const heroNames = ['hero_xueba', 'hero_tiyuweiyan', 'hero_jilinggui', 'hero_banhua'];
// 主角：角色脚贴近格子底边，顶部留白多，故上内缩大、下内缩小(保住脚)
heroNames.forEach((name, i) => {
  const gw = heroes.w / 5, gh = heroes.h / 3;
  const x0 = Math.round((i + 1) * gw) + 14, x1 = Math.round((i + 2) * gw) - 14;
  const y0 = Math.round(0 * gh) + 4, y1 = Math.round(1 * gh) - 1; // 底部几乎不内缩
  const w = x1 - x0, h = y1 - y0;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) heroes.data.copy(data, y * w * 4, ((y0 + y) * heroes.w + x0) * 4, ((y0 + y) * heroes.w + x1) * 4);
  writePNG(path.join(outDir, name + '.png'), w, h, data);
  console.log(name, w + 'x' + h);
});

// 图2：9怪物暗黑版 1024x1024，3行3列。全部9格
const mobs = readPNG(path.join(assets, '一张暗黑邪恶风格的Q版萌系像素游戏怪物设定总览图_美术风格保_2026-11-19T06-32-07.png'));
const mobNames = [
  ['mob_tiaodanxuesheng', 'mob_lurenjia', 'mob_fantangdama'],
  ['mob_laoshi', 'mob_tiyusheng', 'mob_xiaopihai'],
  ['mob_baoan', 'boss_banzhuren', 'boss_jiaodaozhuren'],
];
// 暗黑怪：底部有灰色阴影+AI水印，第三行底部多裁掉约26px去水印，同时角色脚在阴影上方不受影响
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    const name = mobNames[row][col];
    const gw = mobs.w / 3, gh = mobs.h / 3;
    const x0 = Math.round(col * gw) + 14, x1 = Math.round((col + 1) * gw) - 14;
    const y0 = Math.round(row * gh) + 4;
    // 第三行(含BOSS)底部裁到 y=999 去掉最底部水印；前两行正常
    const y1 = row === 2 ? 1000 : Math.round((row + 1) * gh) - 1;
    const w = x1 - x0, h = y1 - y0;
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) mobs.data.copy(data, y * w * 4, ((y0 + y) * mobs.w + x0) * 4, ((y0 + y) * mobs.w + x1) * 4);
    // "AI"水印只出现在整图最右下角(第9格=教导主任)。仅对该格右下角涂白，交抠图删除。
    // 该区域是角色脚边空白，涂抹不影响角色主体（角色居中偏左）。
    if (row === 2 && col === 2) {
      // 水印"AI-"整块位于右下角(x>66%, y>86%)，此处只有水印和边缘暗影，
      // 无角色主体（角色居中偏左，最右的手臂约到x=62%）。整块涂白由抠图阶段删除。
      const wx0 = Math.floor(w * 0.66), wy0 = Math.floor(h * 0.86);
      for (let y = wy0; y < h; y++) for (let x = wx0; x < w; x++) {
        const i = (y * w + x) * 4; data[i + 3] = 0; // 直接透明，避免成为白色孤岛
      }
    }
    writePNG(path.join(outDir, name + '.png'), w, h, data);
    console.log(name, w + 'x' + h);
  }
}
console.log('DONE');
