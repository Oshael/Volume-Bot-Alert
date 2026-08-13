process.env.NODE_ENV = 'test';

// Integration coverage for the one Bloco 1 contract that lives entirely in SQL:
// selectCandidates decides who needs (re)fingerprinting via IS DISTINCT FROM on
// the catalog image plus a failure backoff. The worker unit tests cannot reach
// this — only a real database can.

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const model = require('../src/models/token-image-fingerprint');
const stage123 = require('../src/utils/db-init-stage123');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const CHAIN = 'test-xmatch';
const ADDR = 'tok-select-1';
const HOUR_MS = 60 * 60 * 1000;

async function seedCatalog(imageUrl) {
  await db.query(
    `INSERT INTO token_catalog (address, chain, last_image_url, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (chain, address)
       DO UPDATE SET last_image_url = EXCLUDED.last_image_url, last_seen_at = NOW()`,
    [ADDR, CHAIN, imageUrl],
  );
}

async function candidateAddresses(opts = {}) {
  const rows = await model.selectCandidates({
    limit: 1000,
    retryIntervalMs: opts.retryIntervalMs ?? HOUR_MS,
    now: opts.now,
  });
  return rows.filter((row) => row.chain === CHAIN).map((row) => row.tokenAddress);
}

async function cleanup() {
  await db.query('DELETE FROM token_image_fingerprint WHERE chain = $1', [CHAIN]);
  await db.query('DELETE FROM token_catalog WHERE chain = $1', [CHAIN]);
}

describe('token image fingerprint selectCandidates integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage123.init({ closePool: false });
  });

  beforeEach(cleanup);
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('lists a catalog image that has no fingerprint yet', async () => {
    await seedCatalog('http://img/v1');
    assert.deepEqual(await candidateAddresses(), [ADDR]);
  });

  it('drops the token once fingerprinted for the same image', async () => {
    await seedCatalog('http://img/v1');
    await model.upsertFingerprint({
      chain: CHAIN, tokenAddress: ADDR, sourceImageUrl: 'http://img/v1',
      phash: 1n, dhash: 2n, ok: true,
    });
    assert.deepEqual(await candidateAddresses(), []);
  });

  it('re-lists the token when the catalog image URL changes', async () => {
    await seedCatalog('http://img/v1');
    await model.upsertFingerprint({
      chain: CHAIN, tokenAddress: ADDR, sourceImageUrl: 'http://img/v1',
      phash: 1n, dhash: 2n, ok: true,
    });
    await seedCatalog('http://img/v2');
    assert.deepEqual(await candidateAddresses(), [ADDR]);
  });

  it('holds back a failed image during backoff, then re-lists it', async () => {
    await seedCatalog('http://img/dead');
    await model.upsertFingerprint({
      chain: CHAIN, tokenAddress: ADDR, sourceImageUrl: 'http://img/dead', ok: false,
    });
    // Fresh failure inside the retry window: excluded.
    assert.deepEqual(await candidateAddresses({ retryIntervalMs: HOUR_MS }), []);
    // Once the backoff has elapsed (retryBefore pushed past computed_at): re-listed.
    assert.deepEqual(
      await candidateAddresses({ retryIntervalMs: 0, now: () => Date.now() + 60_000 }),
      [ADDR],
    );
  });
});
