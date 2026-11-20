// 把 assets/anim 下 534 帧透明 PNG 打包成游戏用紧凑图集。
// 纯 Node 实现：读取 RGBA -> 去掉透明边 -> 等比缩放 -> 底部对齐拼格 -> PNG 输出。
// 同时输出 manifest.js（不是 JSON，方便 file:// 直接打开也能加载）。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'anim');
const OUT = path.join(ROOT, 'assets', 'game-atlas');
const CELL_W = 96;
const CELL_H = 112;
const COLS = 8;

const HERO_DIRS = ['down', 'downleft', 'downright', 'left', 'right', 'upleft', 'upright', 'up'];
const MOB_DIRS = ['downleft', 'downright', 'upleft', 'upright'];
const STATES = ['idle', 'run', 'attack', 'hurt1', 'hurt2', 'hurt3', 'hurt4'];

const CHARS = [
  ['hero_xiaopangdun', 'hero'], ['hero_xueba', 'hero'],
  ['hero_tiyuweiyan', 'hero'], ['hero_jilinggui', 'hero'], ['hero_banhua', 'hero'],
  ['mob_tiaodanxuesheng', 'mob'], ['mob_lurenjia', 'mob'], ['mob_fantangdama', 'mob'],
  ['mob_laoshi', 'mob'], ['mob_tiyusheng', 'mob'], ['mob_xiaopihai', 'mob'], ['mob_baoan', 'mob'],
  ['boss_banzhuren', 'boss'], ['boss_jiaodaozhuren', 'boss']
];

function readPNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w, h, ct, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.slice(p + 4, p + 8).toString();
    const d = b.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
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
      else {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
      }
      out[y * stride + x] = v & 255;
    }
  }
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
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(t, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0);
  const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([l, td, c]);
}
function writePNG(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

// 去掉四周全透明像素，返回裁剪后的视图信息
function alphaBBox(im) {
  let x0 = im.w, y0 = im.h, x1 = -1, y1 = -1;
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < im.w; x++) {
      if (im.data[(y * im.w + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 清除 AI 生成图集自带的矩形边框线（横跨整幅的纯黑/浅灰横线或竖线）。
// 关键：边框线是「横跨 bbox 几乎整宽/整高、且亮度均匀」的线，角色本体绝不会如此。
// 逐行/逐列检测，命中才清除；绝不按固定像素宽度裁切——那会切掉头发、耳朵、脚。
function cleanEdgeLines(src, box) {
  // 判断一整行/列是否是「AI 边框线」：
  //   1) 不透明像素横跨 >=90%，且亮度高度一致（10%~90% 分位差，容忍线里混入的少数黑点）；
  //   2) 关键：线的外侧一行/列必须几乎全透明 —— 真正的边框线贴在 bbox 边缘、外侧是空的，
  //      而角色自身的横行（如背面视角的纯黑后脑勺、衣服横纹）上下都有像素相连，外侧不空，
  //      这样就不会再把角色的头/身体当成线误删。
  function spanOf(lums) {
    lums.sort((a, b) => a - b);
    const lo = lums[Math.floor(lums.length * 0.10)];
    const hi = lums[Math.floor(lums.length * 0.90)];
    return hi - lo;
  }
  function countOpaqueRow(y) {
    let n = 0;
    for (let x = box.x; x < box.x + box.w; x++) if (src.data[(y * src.w + x) * 4 + 3] > 40) n++;
    return n;
  }
  function countOpaqueCol(x) {
    let n = 0;
    for (let y = box.y; y < box.y + box.h; y++) if (src.data[(y * src.w + x) * 4 + 3] > 40) n++;
    return n;
  }
  function alphaAt(x, y) {
    if (x < 0 || y < 0 || x >= src.w || y >= src.h) return 0;
    return src.data[(y * src.w + x) * 4 + 3];
  }
  function rowIsLine(y) {
    const lums = [];
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = (y * src.w + x) * 4;
      if (src.data[p + 3] > 40) lums.push((src.data[p] + src.data[p + 1] + src.data[p + 2]) / 3);
    }
    if (lums.length < box.w * 0.9 || spanOf(lums) >= 42) return false;
    // 外侧：离哪条 bbox 边更近就查那一侧
    const outerY = (y - box.y) < (box.y + box.h - 1 - y) ? y - 1 : y + 1;
    let outerCnt = 0;
    for (let x = box.x; x < box.x + box.w; x++) if (alphaAt(x, outerY) > 40) outerCnt++;
    return outerCnt < box.w * 0.3;
  }
  function colIsLine(x) {
    const lums = [];
    for (let y = box.y; y < box.y + box.h; y++) {
      const p = (y * src.w + x) * 4;
      if (src.data[p + 3] > 40) lums.push((src.data[p] + src.data[p + 1] + src.data[p + 2]) / 3);
    }
    if (lums.length < box.h * 0.9 || spanOf(lums) >= 42) return false;
    const outerX = (x - box.x) < (box.x + box.w - 1 - x) ? x - 1 : x + 1;
    let outerCnt = 0;
    for (let y = box.y; y < box.y + box.h; y++) if (alphaAt(outerX, y) > 40) outerCnt++;
    return outerCnt < box.h * 0.3;
  }
  // 大块纯白背景清除函数（侧面真方向帧带白底）。见下方说明。
  function clearWhiteBackgrounds() {
    const isWhite = (x, y) => {
      const p = (y * src.w + x) * 4;
      if (src.data[p + 3] < 20) return false;
      const r = src.data[p], g = src.data[p + 1], b = src.data[p + 2];
      return r > 222 && g > 222 && b > 222 && (Math.max(r, g, b) - Math.min(r, g, b)) < 20;
    };
    const seen = new Uint8Array(src.w * src.h);
    const areaThreshold = box.w * box.h * 0.08;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const start = y * src.w + x;
        if (seen[start] || !isWhite(x, y)) continue;
        const stack = [start]; seen[start] = 1;
        const cells = [];
        while (stack.length) {
          const cur = stack.pop(), cy = (cur / src.w) | 0, cx = cur - cy * src.w;
          cells.push(cur);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < box.x || ny < box.y || nx >= box.x + box.w || ny >= box.y + box.h) continue;
              const ni = ny * src.w + nx;
              if (seen[ni] || !isWhite(nx, ny)) continue;
              seen[ni] = 1; stack.push(ni);
            }
          }
        }
        if (cells.length > areaThreshold) for (const idx of cells) src.data[idx * 4 + 3] = 0;
      }
    }
  }
  // 先清白底：否则白块会挡住其下的边框线，导致边框剥离漏清；白清掉后边框暴露再剥离
  clearWhiteBackgrounds();
  // 反复剥离：部分帧同时存在黑框 + 内层灰线；每轮重算边界，直到没有新线
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let y = box.y; y < box.y + box.h; y++) {
      if (rowIsLine(y)) {
        for (let x = box.x; x < box.x + box.w; x++) src.data[(y * src.w + x) * 4 + 3] = 0;
        changed = true;
      }
    }
    for (let x = box.x; x < box.x + box.w; x++) {
      if (colIsLine(x)) {
        for (let y = box.y; y < box.y + box.h; y++) src.data[(y * src.w + x) * 4 + 3] = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 边框剥离后再清一次白底（边框剥离可能让新的白色区域暴露成大片）
  clearWhiteBackgrounds();
  // 清除孤立杂点：边框清理后常残留 1~2 个独立灰点，它们会把 alphaBBox 撑大，
  // 导致角色在格子顶部/侧面出现一条线。孤立点 = 8 邻域内不透明邻居 <= 1。
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = (y * src.w + x) * 4;
      if (src.data[p + 3] <= 12) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= src.w || ny >= src.h) continue;
          if (src.data[(ny * src.w + nx) * 4 + 3] > 12) neighbors++;
        }
      }
      if (neighbors <= 1) src.data[p + 3] = 0;
    }
  }
  // 清除与主体不相连的低饱和灰色小簇（AI 网格线被剥离后残留的 2~5 像素碎段）。
  // 判据刻意严格：必须是小、扁、灰、中亮、位于上半部、且不是最大连通域。
  // 红色眼睛、蓝色眼泪、白色星星等都因高饱和/高亮而被排除，不会误伤。
  {
    const visited = new Uint8Array(src.w * src.h);
    const clusters = [];
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const start = y * src.w + x;
        if (visited[start] || src.data[start * 4 + 3] <= 12) continue;
        const stack = [start];
        visited[start] = 1;
        const cells = [];
        let cnt = 0, minx = x, maxx = x, miny = y, maxy = y, satSum = 0, lumSum = 0;
        while (stack.length) {
          const cur = stack.pop(), cy = (cur / src.w) | 0, cx = cur - cy * src.w;
          const p = cur * 4, r = src.data[p], g = src.data[p + 1], b = src.data[p + 2];
          cells.push(cur); cnt++;
          if (cx < minx) minx = cx;
          if (cx > maxx) maxx = cx;
          if (cy < miny) miny = cy;
          if (cy > maxy) maxy = cy;
          satSum += Math.max(r, g, b) - Math.min(r, g, b);
          lumSum += (r + g + b) / 3;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx < box.x || ny < box.y || nx >= box.x + box.w || ny >= box.y + box.h) continue;
              const ni = ny * src.w + nx;
              if (visited[ni] || src.data[ni * 4 + 3] <= 12) continue;
              visited[ni] = 1;
              stack.push(ni);
            }
          }
        }
        clusters.push({ cells, cnt, w: maxx - minx + 1, h: maxy - miny + 1,
          miny, sat: satSum / cnt, lum: lumSum / cnt });
      }
    }
    if (clusters.length > 1) {
      let main = 0;
      for (let i = 1; i < clusters.length; i++) if (clusters[i].cnt > clusters[main].cnt) main = i;
      for (let i = 0; i < clusters.length; i++) {
        if (i === main) continue;
        const c = clusters[i];
        if (c.cnt > box.w * box.h * 0.03 || c.h > 4 || c.w < 12) continue;
        if (c.sat > 35 || c.lum > 210) continue;
        if (c.miny > box.y + box.h * 0.5) continue;
        for (const idx of c.cells) src.data[idx * 4 + 3] = 0;
      }
    }
  }
}

// alpha 加权 box 缩放，避免透明黑边污染颜色
function scaleInto(src, box, dw, dh, dest, destW, ox, oy) {
  const xRatio = box.w / dw, yRatio = box.h / dh;
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = box.y + Math.floor(dy * yRatio), sy1 = Math.min(box.y + box.h, box.y + Math.ceil((dy + 1) * yRatio));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = box.x + Math.floor(dx * xRatio), sx1 = Math.min(box.x + box.w, box.x + Math.ceil((dx + 1) * xRatio));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = (sy * src.w + sx) * 4, al = src.data[p + 3];
          r += src.data[p] * al; g += src.data[p + 1] * al; b += src.data[p + 2] * al;
          a += al; n++;
        }
      }
      if (!n) continue;
      const p = ((oy + dy) * destW + ox + dx) * 4;
      if (a > 0) {
        dest[p] = Math.round(r / a); dest[p + 1] = Math.round(g / a);
        dest[p + 2] = Math.round(b / a); dest[p + 3] = Math.round(a / n);
      } else dest[p + 3] = 0;
    }
  }
}

// 图集级：清除一格内与主体不相连的低饱和灰色小簇（缩放后分离的 AI 网格碎线）。
// 只清：小、扁、灰、中亮、位于上半部、非最大簇；彩色/高亮特效（红眼、蓝眼泪、白星星）自动排除。
function cleanCellFragments(buf, bufW, cellX, cellY) {
  const visited = new Uint8Array(CELL_W * CELL_H);
  const clusters = [];
  const alphaAt = (x, y) => buf[((cellY + y) * bufW + cellX + x) * 4 + 3];
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      const start = y * CELL_W + x;
      if (visited[start] || alphaAt(x, y) <= 12) continue;
      const stack = [start];
      visited[start] = 1;
      const cells = [];
      let cnt = 0, minx = x, maxx = x, miny = y, maxy = y, satSum = 0, lumSum = 0;
      while (stack.length) {
        const cur = stack.pop(), cy = (cur / CELL_W) | 0, cx = cur - cy * CELL_W;
        const p = ((cellY + cy) * bufW + cellX + cx) * 4;
        const r = buf[p], g = buf[p + 1], b = buf[p + 2];
        cells.push(cur); cnt++;
        if (cx < minx) minx = cx;
        if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy;
        if (cy > maxy) maxy = cy;
        satSum += Math.max(r, g, b) - Math.min(r, g, b);
        lumSum += (r + g + b) / 3;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= CELL_W || ny >= CELL_H) continue;
            const ni = ny * CELL_W + nx;
            if (visited[ni] || alphaAt(nx, ny) <= 12) continue;
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
      clusters.push({ cells, cnt, w: maxx - minx + 1, h: maxy - miny + 1,
        miny, sat: satSum / cnt, lum: lumSum / cnt });
    }
  }
  if (clusters.length < 2) return;
  let main = 0;
  for (let i = 1; i < clusters.length; i++) if (clusters[i].cnt > clusters[main].cnt) main = i;
  for (let i = 0; i < clusters.length; i++) {
    if (i === main) continue;
    const c = clusters[i];
    if (c.cnt > CELL_W * CELL_H * 0.03 || c.h > 4 || c.w < 12) continue;
    if (c.sat > 35 || c.lum > 210) continue;
    if (c.miny > CELL_H * 0.5) continue;
    for (const idx of c.cells) {
      const x = idx % CELL_W, y = (idx / CELL_W) | 0;
      buf[((cellY + y) * bufW + cellX + x) * 4 + 3] = 0;
    }
  }
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = { cellW: CELL_W, cellH: CELL_H, cols: COLS, chars: {} };
let totalFrames = 0, totalBytes = 0;

for (const [id, kind] of CHARS) {
  const dirs = kind === 'hero' ? HERO_DIRS : MOB_DIRS;
  const rows = STATES.length;
  const atlasW = CELL_W * COLS, atlasH = CELL_H * rows;
  const atlas = Buffer.alloc(atlasW * atlasH * 4);
  const frames = {};
  let slot = 0;
  for (let s = 0; s < STATES.length; s++) {
    for (let d = 0; d < dirs.length; d++) {
      const file = path.join(SRC, id, STATES[s] + '_' + dirs[d] + '.png');
      if (!fs.existsSync(file)) throw new Error('缺少帧: ' + file);
      const im = readPNG(file);
      cleanEdgeLines(im, alphaBBox(im));
      const box = alphaBBox(im);
      const maxH = kind === 'boss' ? 108 : kind === 'hero' ? 94 : 88;
      const maxW = CELL_W - 8;
      const scale = Math.min(maxW / box.w, maxH / box.h);
      const dw = Math.max(1, Math.round(box.w * scale)), dh = Math.max(1, Math.round(box.h * scale));
      const ox = Math.floor((CELL_W - dw) / 2);
      const oy = CELL_H - dh - 3; // 脚底对齐，底部留 3px
      const cx = (slot % COLS) * CELL_W, cy = Math.floor(slot / COLS) * CELL_H;
      scaleInto(im, box, dw, dh, atlas, atlasW, cx + ox, cy + oy);
      frames[STATES[s] + '_' + dirs[d]] = slot++;
      totalFrames++;
    }
  }
  // 清除每格左右边缘 4px：原图集 AI 生成的浅灰网格线会在放大后变成白框。
  // 角色已限制在 maxW=CELL_W-8 并居中，因此这 4px 不会伤到主体。
  for (let c = 0; c < COLS; c++) {
    const x0 = c * CELL_W;
    for (let y = 0; y < atlasH; y++) {
      for (let k = 0; k < 4; k++) {
        atlas[(y * atlasW + x0 + k) * 4 + 3] = 0;
        atlas[(y * atlasW + x0 + CELL_W - 1 - k) * 4 + 3] = 0;
      }
    }
  }
  // 图集级碎线清理：AI 网格线被剥离后，部分灰线要在缩放后才与角色分离，
  // 因此在写文件前对每格再做一次「独立灰色小簇」清理（判据严格，不碰彩色特效）。
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) cleanCellFragments(atlas, atlasW, c * CELL_W, r * CELL_H);
  }
  const file = path.join(OUT, id + '.png');
  writePNG(file, atlasW, atlasH, atlas);
  const bytes = fs.statSync(file).size;
  totalBytes += bytes;
  manifest.chars[id] = { file: id + '.png', kind, rows, frames };
  console.log(id.padEnd(22), slot + ' 帧', (bytes / 1024).toFixed(0) + 'KB');
}

fs.writeFileSync(path.join(OUT, 'manifest.js'), 'window.GAME_ATLAS = ' + JSON.stringify(manifest) + ';\n');
console.log('DONE: ' + totalFrames + ' 帧 / ' + CHARS.length + ' 张图集 / ' + (totalBytes / 1024 / 1024).toFixed(2) + 'MB');
