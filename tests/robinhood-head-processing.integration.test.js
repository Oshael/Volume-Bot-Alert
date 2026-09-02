process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHeadProcessingRepository,
} = require('../src/models/robinhood-head-processing');
const stage103 = require('../src/utils/db-init-stage103');
const stage186 = require('../src/utils/db-init-stage186');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;
const TOPIC = `0x${'d'.repeat(64)}`;
const LEASE_MS = 60_000;
const RETENTION_MS = 86_400_000;
const RANGE_ERROR = 'V4 liquidity range update conflicted or became negative';

const repository = createRobinhoodHeadProcessingRepository({ database: db });

function hashFor(block, logIndex) {
  return `0x${(BigInt(block) * 1000n + BigInt(logIndex)).toString(16).padStart(64, '0')}`;
}

async function seedPending({
  block, logIndex = 0, stream = 'market', attemptCount = 0, dueInMs = 0,
  timestampMs = Date.now(), protocol = 'uniswap-v3',
  marketKey = 'robinhood:uniswap-v3:test', evidence = {},
}) {
  await db.query(
    `INSERT INTO robinhood_head_captures (
       stream, transaction_hash, log_index, block_number, block_hash,
       transaction_index, address, topics, data, protocol, market_key,
       evidence_version, evidence, attempt_count, next_attempt_at
     ) VALUES (
       $1, $2, $3, $4, $5, 0, $6, $7::jsonb, '0x', $8, $9,
       1, $10::jsonb, $11, NOW() + ($12::bigint * INTERVAL '1 millisecond')
     )`,
    [stream, hashFor(block, logIndex), logIndex, block, BLOCK_HASH, ADDRESS,
      JSON.stringify([TOPIC]), protocol, marketKey,
      JSON.stringify({ timestampMs: String(timestampMs), ...evidence }), attemptCount, dueInMs]
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
    await stage186.init({ closePool: false });
  });

  beforeEach(async () => {
    await db.query('DELETE FROM robinhood_head_captures');
    await db.query("DELETE FROM worker_leases WHERE lease_key = 'robinhood-processing-worker'");
  });

  after(async () => {
    await db.pool.end();
  });

  it('leases due pending captures in on-chain order and counts the attempt', async () => {
    await seedPending({ block: 102 });
    await seedPending({ block: 100 });
    await seedPending({ block: 101 });

    const claimed = await repository.claimCaptures({
      owner: 'worker-a', limit: 2, leaseMs: LEASE_MS, stream: 'market',
    });

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

  it('does not let V4 captures overtake an earlier retry or dead-letter in the same pool', async () => {
    const poolA = 'robinhood:uniswap-v4:pool-a';
    const poolB = 'robinhood:uniswap-v4:pool-b';
    const stalled = await seedPending({
      block: 100, protocol: 'uniswap-v4', marketKey: poolA, dueInMs: 3_600_000,
    });
    const laterSamePool = await seedPending({
      block: 101, protocol: 'uniswap-v4', marketKey: poolA,
    });
    await seedPending({ block: 102, protocol: 'uniswap-v4', marketKey: poolB });
    await seedPending({ block: 103 });

    const independent = await repository.claimCaptures({
      owner: 'worker-a', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(independent.map((row) => Number(row.block_number)), [102, 103]);
    assert.equal((await statusOf(laterSamePool)).processing_status, 'pending');

    await db.query(
      `UPDATE robinhood_head_captures SET next_attempt_at = NOW()
       WHERE transaction_hash = $1 AND log_index = $2`,
      [stalled.transactionHash, stalled.logIndex]
    );
    const first = await repository.claimCaptures({
      owner: 'worker-b', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(first.map((row) => Number(row.block_number)), [100]);
    await repository.settleClaims({
      owner: 'worker-b', retentionMs: RETENTION_MS, maxAttempts: 1,
      retry: [{ ...stalled, error: RANGE_ERROR, backoffMs: 1000 }],
    });
    assert.equal((await statusOf(stalled)).processing_status, 'blocked');

    const blocked = await repository.claimCaptures({
      owner: 'worker-c', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(blocked, []);
    assert.equal((await statusOf(laterSamePool)).processing_status, 'pending');

    assert.deepEqual(
      await repository.requeueBlockedRecoveryBatch({ limit: 1, throughBlock: '100' }),
      { requeued: 1, oldestBlock: '100', newestBlock: '100' }
    );
    const recovered = await repository.claimCaptures({
      owner: 'worker-d', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(recovered.map((row) => Number(row.block_number)), [100]);
    await repository.settleClaims({
      owner: 'worker-d', retentionMs: RETENTION_MS, processed: [stalled],
    });
    const resumed = await repository.claimCaptures({
      owner: 'worker-e', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(resumed.map((row) => Number(row.block_number)), [101]);
  });

  it('skip-scans hot V4 pools without claiming more than their oldest capture', async () => {
    const poolA = 'robinhood:uniswap-v4:pool-a';
    const poolB = 'robinhood:uniswap-v4:pool-b';
    await Promise.all(Array.from({ length: 100 }, (_, index) => seedPending({
      block: 100 + index, logIndex: index,
      protocol: 'uniswap-v4', marketKey: poolA,
    })));
    await seedPending({ block: 150, logIndex: 1000, protocol: 'uniswap-v4', marketKey: poolB });

    const claimed = await repository.claimCaptures({
      owner: 'worker-a', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });

    assert.deepEqual(claimed.map((row) => [row.market_key, Number(row.block_number)]), [
      [poolA, 100], [poolB, 150],
    ]);
  });

  it('claims a swap prefix, stops before a V4 delta, then resumes after it settles', async () => {
    const poolA = 'robinhood:uniswap-v4:pool-a';
    const poolB = 'robinhood:uniswap-v4:pool-b';
    const firstA = await seedPending({ block: 100, protocol: 'uniswap-v4', marketKey: poolA });
    const secondA = await seedPending({ block: 101, protocol: 'uniswap-v4', marketKey: poolA });
    const thirdA = await seedPending({ block: 102, protocol: 'uniswap-v4', marketKey: poolA });
    const deltaA = await seedPending({
      block: 103, protocol: 'uniswap-v4', marketKey: poolA,
      evidence: { event: { kind: 'modify-liquidity' } },
    });
    const afterDeltaA = await seedPending({
      block: 104, protocol: 'uniswap-v4', marketKey: poolA,
    });
    const firstB = await seedPending({ block: 105, protocol: 'uniswap-v4', marketKey: poolB });

    const initial = await repository.claimCaptures({
      owner: 'worker-a', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(initial.map((row) => Number(row.block_number)), [100, 105]);
    assert.deepEqual(await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [poolA], limit: 10, leaseMs: LEASE_MS,
    }), []);

    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, processed: [firstA, firstB],
    });
    const continuation = await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [poolA, poolB], limit: 10,
      perPoolLimit: 10, leaseMs: LEASE_MS,
    });
    assert.deepEqual(continuation.map((row) => Number(row.block_number)), [101, 102]);
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS,
      processed: [secondA, thirdA],
    });

    const delta = await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [poolA], limit: 10,
      perPoolLimit: 10, leaseMs: LEASE_MS,
    });
    assert.deepEqual(delta.map((row) => Number(row.block_number)), [103]);
    assert.equal((await statusOf(afterDeltaA)).processing_status, 'pending');
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, processed: [deltaA],
    });

    const resumed = await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [poolA], limit: 10,
      perPoolLimit: 10, leaseMs: LEASE_MS,
    });
    assert.deepEqual(resumed.map((row) => Number(row.block_number)), [104]);
  });

  it('bounds each V4 swap prefix and never crosses an earlier retry barrier', async () => {
    const pool = 'robinhood:uniswap-v4:pool-a';
    const first = await seedPending({ block: 100, protocol: 'uniswap-v4', marketKey: pool });
    await seedPending({ block: 101, protocol: 'uniswap-v4', marketKey: pool });
    const deferred = await seedPending({
      block: 102, protocol: 'uniswap-v4', marketKey: pool, dueInMs: 3_600_000,
    });
    const afterDeferred = await seedPending({
      block: 103, protocol: 'uniswap-v4', marketKey: pool,
    });
    await repository.claimCaptures({
      owner: 'worker-a', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, processed: [first],
    });

    const bounded = await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [pool], limit: 10,
      perPoolLimit: 1, leaseMs: LEASE_MS,
    });
    assert.deepEqual(bounded.map((row) => Number(row.block_number)), [101]);
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS,
      processed: bounded.map((row) => ({
        transactionHash: row.transaction_hash, logIndex: row.log_index,
      })),
    });

    assert.deepEqual(await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [pool], limit: 10,
      perPoolLimit: 10, leaseMs: LEASE_MS,
    }), []);
    assert.equal((await statusOf(deferred)).processing_status, 'pending');
    assert.equal((await statusOf(afterDeferred)).processing_status, 'pending');
  });

  it('never hands the same leased capture to a second consumer', async () => {
    await seedPending({ block: 100 });
    await seedPending({ block: 101 });

    const first = await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS });
    const second = await repository.claimCaptures({ owner: 'worker-b', limit: 5, leaseMs: LEASE_MS });

    assert.deepEqual(first.map((row) => Number(row.block_number)), [100]);
    assert.deepEqual(second.map((row) => Number(row.block_number)), [101]);
  });

  it('claims disjoint ordered market batches for concurrent consumers', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      seedPending({ block: 100 + index })
    )));

    const [first, second] = await Promise.all([
      repository.claimCaptures({
        owner: 'worker-a', limit: 5, leaseMs: LEASE_MS, stream: 'market',
      }),
      repository.claimCaptures({
        owner: 'worker-b', limit: 5, leaseMs: LEASE_MS, stream: 'market',
      }),
    ]);

    const identities = [...first, ...second]
      .map((row) => `${row.transaction_hash}:${row.log_index}`);
    assert.equal(first.length, 5);
    assert.equal(second.length, 5);
    assert.equal(new Set(identities).size, 10);
    assert.deepEqual(first.map((row) => Number(row.block_number)).toSorted((a, b) => a - b),
      first.map((row) => Number(row.block_number)));
    assert.deepEqual(second.map((row) => Number(row.block_number)).toSorted((a, b) => a - b),
      second.map((row) => Number(row.block_number)));
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

  it('anchors the frontier on non-terminal work and skips older dead-letters', async () => {
    const oldestAt = Date.parse('2026-08-06T01:00:00.000Z');
    await seedPending({ block: 101, timestampMs: oldestAt + 1000 });
    await seedPending({ block: 100, timestampMs: oldestAt });
    await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS }); // leases 100
    const blocked = await seedPending({
      block: 99, logIndex: 1, attemptCount: 4, timestampMs: oldestAt - 1000,
    });
    await repository.claimCaptures({ owner: 'worker-b', limit: 1, leaseMs: LEASE_MS }); // leases 99
    await repository.settleClaims({
      owner: 'worker-b', retentionMs: RETENTION_MS, maxAttempts: 5,
      retry: [{ ...blocked, error: 'permanent failure', backoffMs: 1000 }],
    });
    assert.equal((await statusOf(blocked)).processing_status, 'blocked');

    const oldest = await repository.getOldestActiveCapture('market');

    // Block 99 is an older dead-letter; the frontier must not regress onto it,
    // otherwise coverage_end freezes in the past and blacks out recent windows.
    assert.deepEqual(oldest, {
      blockNumber: '100', observedAt: new Date(oldestAt).toISOString(),
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

  it('previews and requeues only bounded V4-contaminated dead-letters in chain order', async () => {
    const unrelated = await seedPending({ block: 99, attemptCount: 4 });
    const first = await seedPending({ block: 100, logIndex: 1, attemptCount: 4 });
    const second = await seedPending({ block: 102, logIndex: 2, attemptCount: 4 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 3, leaseMs: LEASE_MS });
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, maxAttempts: 5,
      retry: [
        { ...unrelated, error: 'different permanent failure', backoffMs: 1000 },
        { ...first, error: RANGE_ERROR, backoffMs: 1000 },
        { ...second, error: RANGE_ERROR, backoffMs: 1000 },
      ],
    });

    const preview = await repository.previewBlockedRecovery({ limit: 1, throughBlock: '102' });
    assert.deepEqual(preview, {
      workerActive: false, candidates: 1,
      oldestBlock: '100', newestBlock: '100', hasMore: true,
    });
    assert.deepEqual(
      await repository.requeueBlockedRecoveryBatch({ limit: 1, throughBlock: '102' }),
      { requeued: 1, oldestBlock: '100', newestBlock: '100' }
    );
    assert.equal((await statusOf(first)).processing_status, 'pending');
    assert.equal((await statusOf(first)).attempt_count, 0);
    assert.equal((await statusOf(second)).processing_status, 'blocked');
    assert.equal((await statusOf(unrelated)).processing_status, 'blocked');
  });

  it('refuses blocked recovery while the processing worker lease is active', async () => {
    await db.query(
      `INSERT INTO worker_leases (
         lease_key, owner_id, lease_until
       ) VALUES ('robinhood-processing-worker', 'test-owner', NOW() + INTERVAL '1 minute')`
    );

    await assert.rejects(
      repository.requeueBlockedRecoveryBatch({ limit: 1, throughBlock: '100' }),
      (error) => error.code === 'robinhood_processing_worker_active'
    );
  });
});
