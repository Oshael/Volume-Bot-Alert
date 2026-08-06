process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHeadProcessingRepository,
} = require('../src/models/robinhood-head-processing');
const stage103 = require('../src/utils/db-init-stage103');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;
const TOPIC = `0x${'d'.repeat(64)}`;
const LEASE_MS = 60_000;
const RETENTION_MS = 86_400_000;

const repository = createRobinhoodHeadProcessingRepository({ database: db });

function hashFor(block, logIndex) {
  return `0x${(BigInt(block) * 1000n + BigInt(logIndex)).toString(16).padStart(64, '0')}`;
}

async function seedPending({
  block, logIndex = 0, stream = 'market', attemptCount = 0, dueInMs = 0,
  timestampMs = Date.now(),
}) {
  await db.query(
    `INSERT INTO robinhood_head_captures (
       stream, transaction_hash, log_index, block_number, block_hash,
       transaction_index, address, topics, data, protocol, market_key,
       evidence_version, evidence, attempt_count, next_attempt_at
     ) VALUES (
       $1, $2, $3, $4, $5, 0, $6, $7::jsonb, '0x', 'uniswap-v3', 'robinhood:uniswap-v3:test',
       1, $8::jsonb, $9, NOW() + ($10::bigint * INTERVAL '1 millisecond')
     )`,
    [stream, hashFor(block, logIndex), logIndex, block, BLOCK_HASH, ADDRESS,
      JSON.stringify([TOPIC]), JSON.stringify({ timestampMs: String(timestampMs) }),
      attemptCount, dueInMs]
  );
  return { transactionHash: hashFor(block, logIndex), logIndex };
}

async function statusOf(identity) {
  const result = await db.query(
    `SELECT processing_status, attempt_count, lease_owner, lease_until,
            terminal_at, retention_eligible_at, next_attempt_at, last_error
       FROM robinhood_head_captures WHERE transaction_hash = $1 AND log_index = $2`,
    [identity.transactionHash, identity.logIndex]
  );
  return result.rows[0];
}

describe('Robinhood head processing repository integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage103.init({ closePool: false });
  });

  beforeEach(async () => {
    await db.query('DELETE FROM robinhood_head_captures');
  });

  after(async () => {
    await db.pool.end();
  });

  it('leases due pending captures in on-chain order and counts the attempt', async () => {
    await seedPending({ block: 102 });
    await seedPending({ block: 100 });
    await seedPending({ block: 101 });

    const claimed = await repository.claimCaptures({ owner: 'worker-a', limit: 2, leaseMs: LEASE_MS });

    assert.deepEqual(claimed.map((row) => Number(row.block_number)), [100, 101]);
    const first = await statusOf({ transactionHash: claimed[0].transaction_hash, logIndex: 0 });
    assert.equal(first.processing_status, 'leased');
    assert.equal(first.attempt_count, 1);
    assert.equal(first.lease_owner, 'worker-a');
    assert.ok(first.lease_until > new Date());
  });

  it('does not claim a capture whose next attempt is still in the future', async () => {
    await seedPending({ block: 100, dueInMs: 3_600_000 });
    const claimed = await repository.claimCaptures({ owner: 'worker-a', limit: 5, leaseMs: LEASE_MS });
    assert.equal(claimed.length, 0);
  });

  it('never hands the same leased capture to a second consumer', async () => {
    await seedPending({ block: 100 });
    await seedPending({ block: 101 });

    const first = await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS });
    const second = await repository.claimCaptures({ owner: 'worker-b', limit: 5, leaseMs: LEASE_MS });

    assert.deepEqual(first.map((row) => Number(row.block_number)), [100]);
    assert.deepEqual(second.map((row) => Number(row.block_number)), [101]);
  });

  it('settles processed and rejected claims as terminal with retention', async () => {
    const keep = await seedPending({ block: 100 });
    const drop = await seedPending({ block: 101 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 5, leaseMs: LEASE_MS });

    const result = await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS,
      processed: [keep], rejected: [{ ...drop, reason: 'quote_usd_unavailable' }],
    });

    assert.deepEqual(result, { processed: 1, rejected: 1, retried: 0, blocked: 0 });
    const processed = await statusOf(keep);
    assert.equal(processed.processing_status, 'processed');
    assert.equal(processed.lease_owner, null);
    assert.ok(processed.terminal_at instanceof Date);
    assert.ok(processed.retention_eligible_at > processed.terminal_at);
    const rejected = await statusOf(drop);
    assert.equal(rejected.processing_status, 'rejected');
    assert.equal(rejected.last_error, 'quote_usd_unavailable');
  });

  it('refuses to settle a claim leased by a different owner', async () => {
    const identity = await seedPending({ block: 100 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 5, leaseMs: LEASE_MS });

    const result = await repository.settleClaims({
      owner: 'worker-b', retentionMs: RETENTION_MS, processed: [identity],
    });

    assert.equal(result.processed, 0);
    assert.equal((await statusOf(identity)).processing_status, 'leased');
  });

  it('reschedules a retry with backoff but dead-letters once attempts are exhausted', async () => {
    const retryable = await seedPending({ block: 100, attemptCount: 0 });
    const exhausted = await seedPending({ block: 101, logIndex: 1, attemptCount: 4 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 5, leaseMs: LEASE_MS });

    const result = await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, maxAttempts: 5,
      retry: [
        { ...retryable, error: 'rpc timeout', backoffMs: 30_000 },
        { ...exhausted, error: 'rpc timeout', backoffMs: 30_000 },
      ],
    });

    assert.deepEqual(result, { processed: 0, rejected: 0, retried: 1, blocked: 1 });
    const rescheduled = await statusOf(retryable);
    assert.equal(rescheduled.processing_status, 'pending');
    assert.ok(rescheduled.next_attempt_at > new Date());
    assert.equal((await statusOf(exhausted)).processing_status, 'blocked');
  });

  it('reclaims only leases abandoned past their expiry', async () => {
    const stale = await seedPending({ block: 100 });
    const fresh = await seedPending({ block: 101, logIndex: 1 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 5, leaseMs: LEASE_MS });
    await db.query(
      `UPDATE robinhood_head_captures SET lease_until = NOW() - INTERVAL '1 hour'
         WHERE transaction_hash = $1 AND log_index = $2`,
      [stale.transactionHash, stale.logIndex]
    );

    const reclaimed = await repository.reclaimExpiredLeases();

    assert.equal(reclaimed, 1);
    assert.equal((await statusOf(stale)).processing_status, 'pending');
    assert.equal((await statusOf(fresh)).processing_status, 'leased');
  });

  it('reports the lowest non-terminal block and queue depth as the watermark', async () => {
    const done = await seedPending({ block: 99 });
    await seedPending({ block: 100 });
    await seedPending({ block: 101, logIndex: 1 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS }); // leases 99
    await repository.settleClaims({ owner: 'worker-a', retentionMs: RETENTION_MS, processed: [done] });

    const watermark = await repository.getProcessingWatermark('market');

    assert.equal(watermark.pendingBlock, '100');
    assert.equal(watermark.pending, 2);
    assert.equal(watermark.leased, 0);
    assert.equal(watermark.blocked, 0);
  });

  it('reports the oldest pending, leased or blocked evidence without scanning terminal history', async () => {
    const oldestAt = Date.parse('2026-08-06T01:00:00.000Z');
    await seedPending({ block: 101, timestampMs: oldestAt + 1000 });
    await seedPending({ block: 100, timestampMs: oldestAt });
    await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS });
    const blocked = await seedPending({
      block: 99, logIndex: 1, attemptCount: 4, timestampMs: oldestAt - 1000,
    });
    await repository.claimCaptures({ owner: 'worker-b', limit: 1, leaseMs: LEASE_MS });
    await repository.settleClaims({
      owner: 'worker-b', retentionMs: RETENTION_MS, maxAttempts: 5,
      retry: [{ ...blocked, error: 'permanent failure', backoffMs: 1000 }],
    });

    const oldest = await repository.getOldestActiveCapture('market');

    assert.deepEqual(oldest, {
      blockNumber: '99', observedAt: new Date(oldestAt - 1000).toISOString(),
    });
  });

  it('prunes only terminal captures whose retention window has elapsed', async () => {
    const expired = await seedPending({ block: 100 });
    const fresh = await seedPending({ block: 101, logIndex: 1 });
    const pending = await seedPending({ block: 102 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 2, leaseMs: LEASE_MS }); // leases 100, 101
    await repository.settleClaims({ owner: 'worker-a', retentionMs: RETENTION_MS, processed: [expired, fresh] });
    await db.query(
      `UPDATE robinhood_head_captures
         SET terminal_at = NOW() - INTERVAL '2 minutes',
             retention_eligible_at = NOW() - INTERVAL '1 minute'
         WHERE transaction_hash = $1 AND log_index = $2`,
      [expired.transactionHash, expired.logIndex]
    );

    const pruned = await repository.pruneExpiredCaptures({ limit: 100 });

    assert.equal(pruned, 1);
    assert.equal(await statusOf(expired), undefined);
    assert.equal((await statusOf(fresh)).processing_status, 'processed'); // retention still in the future
    assert.equal((await statusOf(pending)).processing_status, 'pending'); // never terminal
  });
});
