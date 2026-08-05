process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodDerivedOutboxRepository,
} = require('../src/models/robinhood-derived-outbox');
const stage104 = require('../src/utils/db-init-stage104');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'a'.repeat(40)}`;
const LEASE_MS = 60_000;

const repository = createRobinhoodDerivedOutboxRepository({ database: db });

function payloadFor(block) {
  return { type: 'market:bucket', chain: 'robinhood', address: TOKEN, block };
}

async function seed({ block, dueInMs = 0, attemptCount = 0, status = 'pending' } = {}) {
  const result = await db.query(
    `INSERT INTO robinhood_derived_outbox (
       protocol, market_key, token_address, bucket_ts,
       last_block_number, last_log_index, payload, status, attempt_count, next_attempt_at
     ) VALUES (
       'uniswap-v3', 'robinhood:uniswap-v3:test', $1, NOW(),
       $2, 0, $3::jsonb, $4, $5, NOW() + ($6::bigint * INTERVAL '1 millisecond')
     ) RETURNING id`,
    [TOKEN, block, JSON.stringify(payloadFor(block)), status, attemptCount, dueInMs]
  );
  return String(result.rows[0].id);
}

async function rowOf(id) {
  const result = await db.query(
    `SELECT status, attempt_count, lease_owner, lease_until, next_attempt_at, last_error
       FROM robinhood_derived_outbox WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

describe('Robinhood derived outbox repository integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage104.init({ closePool: false });
  });

  beforeEach(async () => {
    await db.query('DELETE FROM robinhood_derived_outbox');
  });

  after(async () => {
    await db.pool.end();
  });

  it('leases due pending rows in append order, carrying the payload and counting the attempt', async () => {
    const first = await seed({ block: 100 });
    const second = await seed({ block: 101 });
    await seed({ block: 102 });

    const claimed = await repository.claimOutbox({ owner: 'derived-a', limit: 2, leaseMs: LEASE_MS });

    assert.deepEqual(claimed.map((row) => row.id), [first, second]);
    assert.deepEqual(claimed.map((row) => row.payload.block), [100, 101]);
    const row = await rowOf(first);
    assert.equal(row.status, 'leased');
    assert.equal(row.attempt_count, 1);
    assert.equal(row.lease_owner, 'derived-a');
  });

  it('does not lease a row whose backoff has not elapsed', async () => {
    await seed({ block: 100, dueInMs: 60_000 });
    const claimed = await repository.claimOutbox({ owner: 'derived-a', limit: 10, leaseMs: LEASE_MS });
    assert.equal(claimed.length, 0);
  });

  it('deletes delivered rows and reschedules retried rows with backoff', async () => {
    const delivered = await seed({ block: 100 });
    const retried = await seed({ block: 101 });
    await repository.claimOutbox({ owner: 'derived-a', limit: 10, leaseMs: LEASE_MS });

    const summary = await repository.settleOutbox({
      owner: 'derived-a',
      delivered: [delivered],
      retry: [{ id: retried, error: 'socket relay down', backoffMs: 5_000 }],
      maxAttempts: 5,
    });

    assert.equal(summary.delivered, 1);
    assert.equal(summary.retried, 1);
    assert.equal(summary.blocked, 0);
    assert.equal(await rowOf(delivered), null);
    const retryRow = await rowOf(retried);
    assert.equal(retryRow.status, 'pending');
    assert.equal(retryRow.last_error, 'socket relay down');
    assert.equal(new Date(retryRow.next_attempt_at) > new Date(), true);
  });

  it('dead-letters a row that exhausts its attempts', async () => {
    const poison = await seed({ block: 100, attemptCount: 4 });
    await repository.claimOutbox({ owner: 'derived-a', limit: 10, leaseMs: LEASE_MS });

    const summary = await repository.settleOutbox({
      owner: 'derived-a',
      retry: [{ id: poison, error: 'boom', backoffMs: 1_000 }],
      maxAttempts: 5,
    });

    assert.equal(summary.blocked, 1);
    assert.equal(summary.retried, 0);
    assert.equal((await rowOf(poison)).status, 'blocked');
  });

  it('ignores a settle from an owner that does not hold the lease', async () => {
    const id = await seed({ block: 100 });
    await repository.claimOutbox({ owner: 'derived-a', limit: 10, leaseMs: LEASE_MS });

    const summary = await repository.settleOutbox({ owner: 'derived-b', delivered: [id] });

    assert.equal(summary.delivered, 0);
    assert.equal((await rowOf(id)).status, 'leased');
  });

  it('reclaims an abandoned lease back to pending', async () => {
    const id = await seed({ block: 100 });
    await repository.claimOutbox({ owner: 'derived-a', limit: 10, leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const reclaimed = await repository.reclaimExpiredLeases();

    assert.equal(reclaimed, 1);
    assert.equal((await rowOf(id)).status, 'pending');
  });
});
