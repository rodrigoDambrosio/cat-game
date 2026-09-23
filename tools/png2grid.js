// Converts a pixel-art PNG into the text grid the game uses for sprites.
// No dependencies: decodes the PNG with Node's zlib.
//
//   node tools/png2grid.js image.png          -> preview several widths
//   node tools/png2grid.js image.png 22       -> print the rows for that width
const fs = require('fs');
const zlib = require('zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (ihdr.interlace) throw new Error('interlaced PNG not supported');
  if (ihdr.bitDepth !== 8) throw new Error('bitDepth ' + ihdr.bitDepth + ' not supported');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.width * bpp;
  const out = Buffer.alloc(ihdr.height * stride);

  let pos = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride);
    pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }

  const rgba = new Uint8Array(ihdr.width * ihdr.height * 4);
  for (let i = 0, n = ihdr.width * ihdr.height; i < n; i++) {
    let r, g, b, a = 255;
    if (ihdr.colorType === 6) { r = out[i*4]; g = out[i*4+1]; b = out[i*4+2]; a = out[i*4+3]; }
    else if (ihdr.colorType === 2) { r = out[i*3]; g = out[i*3+1]; b = out[i*3+2]; }
    else if (ihdr.colorType === 0) { r = g = b = out[i]; }
    else if (ihdr.colorType === 4) { r = g = b = out[i*2]; a = out[i*2+1]; }
    else if (ihdr.colorType === 3) {
      const idx = out[i];
      r = palette[idx*3]; g = palette[idx*3+1]; b = palette[idx*3+2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba[i*4] = r; rgba[i*4+1] = g; rgba[i*4+2] = b; rgba[i*4+3] = a;
  }
  return { width: ihdr.width, height: ihdr.height, rgba };
}

module.exports = { decodePng };
if (require.main !== module) return;

const file = process.argv[2];
const { width, height, rgba } = decodePng(fs.readFileSync(file));

// ink mask: dark, opaque pixels
const mask = [];
for (let y = 0; y < height; y++) {
  const row = [];
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i+1] + 0.114 * rgba[i+2];
    row.push(rgba[i + 3] >= 128 && lum < 128);
  }
  mask.push(row);
}

let x0 = width, y0 = height, x1 = -1, y1 = -1;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (mask[y][x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
}
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

// Fraction of ink pixels inside a cell.
function inkRatio(sx, sy, cell) {
  let ink = 0, total = 0;
  const ax0 = Math.round(sx), ax1 = Math.round(sx + cell);
  const ay0 = Math.round(sy), ay1 = Math.round(sy + cell);
  for (let y = ay0; y < ay1; y++) {
    for (let x = ax0; x < ax1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      total++;
      if (mask[y][x]) ink++;
    }
  }
  return total ? ink / total : 0;
}

// Tries sub-cell offsets and keeps the one with the fewest ambiguous cells:
// when the grid is aligned, nearly every cell is clearly empty or filled.
function build(targetW) {
  const cell = bw / targetW;
  const targetH = Math.round(bh / cell);
  let best = null;
  const steps = 12;
  for (let iy = 0; iy < steps; iy++) {
    for (let ix = 0; ix < steps; ix++) {
      const dx = (ix / steps - 0.5) * cell;
      const dy = (iy / steps - 0.5) * cell;
      let score = 0;
      const ratios = [];
      for (let gy = 0; gy < targetH; gy++) {
        const rowR = [];
        for (let gx = 0; gx < targetW; gx++) {
          const r = inkRatio(x0 + dx + gx * cell, y0 + dy + gy * cell, cell);
          rowR.push(r);
          if (r < 0.2 || r > 0.8) score++;
        }
        ratios.push(rowR);
      }
      if (!best || score > best.score) best = { score, ratios };
    }
  }
  const rows = best.ratios.map(r => r.map(v => (v > 0.5 ? 'o' : '.')).join(''));
  const decisive = (best.score / (targetW * targetH) * 100).toFixed(0);
  return { rows, cell, targetH, decisive };
}

console.log('image: ' + width + 'x' + height + ' | content: ' + bw + 'x' + bh + '\n');

const widths = process.argv[3] ? [parseInt(process.argv[3], 10)] : [20, 21, 22, 23, 24, 26];
for (const w of widths) {
  const { rows, cell, targetH, decisive } = build(w);
  console.log('=== ' + w + 'x' + targetH + ' (cell ' + cell.toFixed(2) + 'px, ' +
              decisive + '% crisp cells) ===');
  rows.forEach(r => console.log('  ' + [...r].map(c => c === 'o' ? '##' : '  ').join('')));
  console.log('');
}

if (process.argv[3]) {
  console.log('--- rows for SPRITE_BASE ---');
  build(parseInt(process.argv[3], 10)).rows.forEach(r => console.log("    '" + r + "',"));
}
