'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { fingerprint, hamming } = require('../src/utils/image-fingerprint');

// Encode a single-channel grayscale grid to PNG so it can be fed to fingerprint
// exactly like a downloaded image would be.
function grayPng(width, height, valueAt) {
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw[y * width + x] = valueAt(x, y);
  }
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

test('hamming counts differing bits', () => {
  assert.equal(hamming(0n, 0n), 0);
  assert.equal(hamming(0b1011n, 0b0001n), 2);
  assert.equal(hamming(0n, (1n << 64n) - 1n), 64);
});

test('identical image yields distance zero on both hashes', async () => {
  // Vertical split so the DCT/gradient carry real structure (a flat image would
  // hash to zero and prove nothing).
  const png = await grayPng(64, 64, (x) => (x < 32 ? 20 : 220));
  const a = await fingerprint(png);
  const b = await fingerprint(png);
  assert.equal(hamming(a.phash, b.phash), 0);
  assert.equal(hamming(a.dhash, b.dhash), 0);
});

test('structurally different images are far apart', async () => {
  const vertical = await grayPng(64, 64, (x) => (x < 32 ? 20 : 220));
  const horizontal = await grayPng(64, 64, (_x, y) => (y < 32 ? 20 : 220));
  const a = await fingerprint(vertical);
  const b = await fingerprint(horizontal);
  // A vertical vs horizontal split must separate clearly on at least one hash;
  // this guards the discrimination contract the matcher relies on.
  assert.ok(
    hamming(a.phash, b.phash) > 8 || hamming(a.dhash, b.dhash) > 8,
    'expected a large Hamming distance between orthogonal splits',
  );
});
