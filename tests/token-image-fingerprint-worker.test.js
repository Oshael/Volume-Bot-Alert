'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toSignedBigInt,
  fromSignedBigInt,
} = require('../src/models/token-image-fingerprint');
const {
  createTokenImageFingerprintWorker,
} = require('../src/services/token-image-fingerprint-worker');

test('signed/unsigned BigInt round-trips across the 63-bit boundary', () => {
  const highBitSet = (1n << 63n) | 123n; // would overflow signed BIGINT
  const stored = toSignedBigInt(highBitSet);
  assert.ok(stored < 0n, 'high-bit hashes must be stored as negative BIGINT');
  assert.equal(fromSignedBigInt(stored), highBitSet);
  assert.equal(toSignedBigInt(null), null);
  assert.equal(fromSignedBigInt(null), null);
});

function fakeModel(candidates) {
  const upserts = [];
  return {
    upserts,
    selectCandidates: async () => candidates,
    upsertFingerprint: async (entry) => { upserts.push(entry); },
  };
}

test('runOnce fingerprints good images in both orientations and upserts', async () => {
  const model = fakeModel([{ chain: 'solana', tokenAddress: 'A', sourceImageUrl: 'http://img/a' }]);
  const worker = createTokenImageFingerprintWorker({
    model,
    download: async () => Buffer.from('image-bytes'),
    fingerprintBoth: async () => ({ phash: 1n, dhash: 2n, phashMirror: 3n, dhashMirror: 4n }),
  });

  await worker.runOnce();

  assert.equal(model.upserts.length, 1);
  assert.deepEqual(model.upserts[0], {
    chain: 'solana', tokenAddress: 'A', sourceImageUrl: 'http://img/a',
    phash: 1n, dhash: 2n, phashMirror: 3n, dhashMirror: 4n, ok: true,
  });
  assert.equal(worker.getStatus().computed, 1);
});

test('runOnce marks a failed download as ok:false without hashes', async () => {
  const model = fakeModel([{ chain: 'solana', tokenAddress: 'B', sourceImageUrl: 'http://img/dead' }]);
  const worker = createTokenImageFingerprintWorker({
    model,
    download: async () => null, // download failure
    fingerprintBoth: async () => { throw new Error('should not decode'); },
  });

  await worker.runOnce();

  assert.equal(model.upserts.length, 1);
  assert.equal(model.upserts[0].ok, false);
  assert.equal(model.upserts[0].phash, undefined);
  assert.equal(worker.getStatus().failed, 1);
});

test('runOnce marks a decode error as ok:false and counts the error', async () => {
  const model = fakeModel([{ chain: 'solana', tokenAddress: 'C', sourceImageUrl: 'http://img/corrupt' }]);
  const worker = createTokenImageFingerprintWorker({
    model,
    download: async () => Buffer.from('not-an-image'),
    fingerprintBoth: async () => { throw new Error('bad decode'); },
    logger: { warn: () => {}, error: () => {} },
  });

  await worker.runOnce();

  assert.equal(model.upserts[0].ok, false);
  const status = worker.getStatus();
  assert.equal(status.failed, 1);
  assert.equal(status.errors, 1);
});

test('runOnce iterates the whole batch', async () => {
  const candidates = ['A', 'B', 'C'].map((a) => ({ chain: 'solana', tokenAddress: a, sourceImageUrl: `http://img/${a}` }));
  const model = fakeModel(candidates);
  const worker = createTokenImageFingerprintWorker({
    model,
    download: async () => Buffer.from('x'),
    fingerprintBoth: async () => ({ phash: 0n, dhash: 0n, phashMirror: 0n, dhashMirror: 0n }),
  });

  await worker.runOnce();

  assert.equal(model.upserts.length, 3);
  assert.equal(worker.getStatus().candidates, 3);
});
