'use strict';

// Perceptual image fingerprints (pHash via DCT, dHash via gradient) plus the
// Hamming comparator. This is the durable core of the X-post/token match plan:
// the same hashes are consumed by the fingerprint worker (Bloco 1) and the
// post-image pipeline (Bloco 4). Keep it deterministic and dependency-light so
// the probe (Bloco 0) measures exactly what production will compute.

const sharp = require('sharp');

const PHASH_SIZE = 32; // DCT works on a 32x32 luminance grid
const PHASH_LOW = 8; // keep the low-frequency 8x8 block -> 64 bits
const DHASH_W = 9; // 9 columns -> 8 horizontal gradients per row
const DHASH_H = 8; // 8 rows -> 64 bits

// Precompute the DCT-II cosine basis once. table[u][x] is the cosine weight of
// input sample x for output coefficient u.
const DCT_COS = (() => {
  const table = new Array(PHASH_SIZE);
  for (let u = 0; u < PHASH_SIZE; u += 1) {
    const row = new Float64Array(PHASH_SIZE);
    for (let x = 0; x < PHASH_SIZE; x += 1) {
      row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE));
    }
    table[u] = row;
  }
  return table;
})();

function dct1d(vector) {
  const out = new Float64Array(PHASH_SIZE);
  for (let u = 0; u < PHASH_SIZE; u += 1) {
    const cos = DCT_COS[u];
    let sum = 0;
    for (let x = 0; x < PHASH_SIZE; x += 1) sum += vector[x] * cos[x];
    out[u] = sum;
  }
  return out;
}

// Separable 2D DCT: transform rows, then columns of the result.
function dct2d(rows) {
  const rowDct = new Array(PHASH_SIZE);
  for (let y = 0; y < PHASH_SIZE; y += 1) rowDct[y] = dct1d(rows[y]);

  const result = new Array(PHASH_SIZE);
  for (let y = 0; y < PHASH_SIZE; y += 1) result[y] = new Float64Array(PHASH_SIZE);

  const col = new Float64Array(PHASH_SIZE);
  for (let x = 0; x < PHASH_SIZE; x += 1) {
    for (let y = 0; y < PHASH_SIZE; y += 1) col[y] = rowDct[y][x];
    const colDct = dct1d(col);
    for (let y = 0; y < PHASH_SIZE; y += 1) result[y][x] = colDct[y];
  }
  return result;
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function phashFromGray(gray) {
  const rows = new Array(PHASH_SIZE);
  for (let y = 0; y < PHASH_SIZE; y += 1) {
    const row = new Float64Array(PHASH_SIZE);
    for (let x = 0; x < PHASH_SIZE; x += 1) row[x] = gray[y * PHASH_SIZE + x];
    rows[y] = row;
  }
  const dct = dct2d(rows);

  // Median over the low-frequency block excluding the DC term (0,0), which only
  // carries overall brightness and would bias the threshold.
  const lowCoeffs = [];
  for (let y = 0; y < PHASH_LOW; y += 1) {
    for (let x = 0; x < PHASH_LOW; x += 1) {
      if (x === 0 && y === 0) continue;
      lowCoeffs.push(dct[y][x]);
    }
  }
  const med = median(lowCoeffs);

  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < PHASH_LOW; y += 1) {
    for (let x = 0; x < PHASH_LOW; x += 1) {
      if (dct[y][x] > med) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash;
}

function dhashFromGray(gray) {
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < DHASH_H; y += 1) {
    for (let x = 0; x < DHASH_W - 1; x += 1) {
      const left = gray[y * DHASH_W + x];
      const right = gray[y * DHASH_W + x + 1];
      if (left > right) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash;
}

// Decode with sharp, force grayscale, resize to the target grid, and return a
// single-channel byte array regardless of how many channels sharp emits.
async function toGray(input, width, height) {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .greyscale()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels || 1;
  if (channels === 1) return data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) gray[i] = data[i * channels];
  return gray;
}

// Compute both hashes for an encoded image buffer (or file path).
async function fingerprint(input) {
  const [phashGray, dhashGray] = await Promise.all([
    toGray(input, PHASH_SIZE, PHASH_SIZE),
    toGray(input, DHASH_W, DHASH_H),
  ]);
  return { phash: phashFromGray(phashGray), dhash: dhashFromGray(dhashGray) };
}

// Hamming distance between two 64-bit fingerprints (Kernighan popcount).
function hamming(a, b) {
  let diff = BigInt(a) ^ BigInt(b);
  let count = 0;
  while (diff) {
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

module.exports = {
  fingerprint,
  hamming,
  phashFromGray,
  dhashFromGray,
  PHASH_SIZE,
  PHASH_LOW,
  DHASH_W,
  DHASH_H,
};
