// Ritar Scanys PWA-ikoner (streckkod på mörk platta) utan extra beroenden.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function createPng(size, pixelFn) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  return Buffer.concat([sig, chunk('IHDR', ihdr), idat, chunk('IEND', Buffer.alloc(0))]);
}

function inRoundRect(x, y, l, t, r, b, rad) {
  if (x < l || y < t || x >= r || y >= b) return false;
  const dx = x < l + rad ? l + rad - x : x >= r - rad ? x - (r - rad - 1) : 0;
  const dy = y < t + rad ? t + rad - y : y >= b - rad ? y - (b - rad - 1) : 0;
  if (!dx || !dy) return true;
  return dx * dx + dy * dy <= rad * rad;
}

function drawIcon(x, y, size, maskable) {
  const bg = [12, 15, 10, 255];
  const green = [74, 222, 128, 255];
  const ink = [12, 15, 10, 255];
  if (maskable) {
    // Maskable: bakgrunden fyller hela ytan, märket ligger i säkra zonen (mitten ~60%).
    const l = size * 0.30;
    const t = size * 0.36;
    const r = size * 0.70;
    const b = size * 0.64;
    const bars = [[0.00, 0.16], [0.22, 0.07], [0.34, 0.12], [0.52, 0.05], [0.64, 0.14], [0.84, 0.08]];
    for (const [start, width] of bars) {
      const x0 = l + (r - l) * start;
      const x1 = x0 + (r - l) * width;
      if (x >= x0 && x < x1 && y >= t && y < b) return green;
    }
    return bg;
  }
  const margin = Math.round(size * 0.08);
  const radius = Math.round(size * 0.18);
  if (!inRoundRect(x, y, margin, margin, size - margin, size - margin, radius)) return bg;
  const innerL = margin + (size - 2 * margin) * 0.22;
  const innerR = size - margin - (size - 2 * margin) * 0.18;
  const innerT = margin + (size - 2 * margin) * 0.30;
  const innerB = size - margin - (size - 2 * margin) * 0.30;
  const w = innerR - innerL;
  const bars = [[0.00, 0.16], [0.22, 0.07], [0.34, 0.12], [0.52, 0.05], [0.64, 0.14], [0.84, 0.08]];
  for (const [start, width] of bars) {
    const x0 = innerL + w * start;
    const x1 = x0 + w * width;
    if (x >= x0 && x < x1 && y >= innerT && y < innerB) return ink;
  }
  return green;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), createPng(192, (x, y, s) => drawIcon(x, y, s, false)));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), createPng(512, (x, y, s) => drawIcon(x, y, s, false)));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), createPng(512, (x, y, s) => drawIcon(x, y, s, true)));
console.log('PWA-ikoner skrivna till', outDir);
