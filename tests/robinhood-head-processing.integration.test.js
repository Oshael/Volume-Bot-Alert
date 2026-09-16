process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHeadProcessingRepository,
} = require('../src/models/robinhood-head-processing');
const {
  createRobinhoodHeadCaptureStateRepository,
} = require('../src/models/robinhood-head-capture-state');
const stage103 = require('../src/utils/db-init-stage103');
const stage186 = require('../src/utils/db-init-stage186');
const stage224 = require('../src/utils/db-init-stage224');
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

async function waitForActivity(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query(
      `SELECT application_name, wait_event_type, wait_event, query
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`
    );
    if (result.rows.some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('Robinhood head processing repository integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage103.init({ closePool: false });
    await stage186.init({ closePool: false });
    await stage224.init({ closePool: false });
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

  it('claims an ordered mixed V4 prefix without crossing a retry barrier', async () => {
    const poolA = 'robinhood:uniswap-v4:pool-a';
    const poolB = 'robinhood:uniswap-v4:pool-b';
    const firstA = await seedPending({ block: 100, protocol: 'uniswap-v4', marketKey: poolA });
    await seedPending({ block: 101, protocol: 'uniswap-v4', marketKey: poolA });
    await seedPending({ block: 102, protocol: 'uniswap-v4', marketKey: poolA });
    await seedPending({
      block: 103, protocol: 'uniswap-v4', marketKey: poolA,
      evidence: { event: { kind: 'modify-liquidity' } },
    });
    await seedPending({
      block: 104, protocol: 'uniswap-v4', marketKey: poolA,
      evidence: { event: { kind: 'modify-liquidity' } },
    });
    await seedPending({ block: 105, protocol: 'uniswap-v4', marketKey: poolA });
    await seedPending({
      block: 107, protocol: 'uniswap-v4', marketKey: poolA,
      evidence: { event: { kind: 'modify-liquidity' } },
    });
    const firstB = await seedPending({ block: 106, protocol: 'uniswap-v4', marketKey: poolB });

    const initial = await repository.claimCaptures({
      owner: 'worker-a', limit: 10, leaseMs: LEASE_MS, stream: 'market',
    });
    assert.deepEqual(initial.map((row) => Number(row.block_number)), [100, 106]);
    assert.deepEqual(await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [poolA], limit: 10, leaseMs: LEASE_MS,
    }), []);

    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, processed: [firstA, firstB],
    });
    const continuation = await repository.claimV4Continuations({
      owner: 'worker-a', marketKeys: [poolA], limit: 10,
      perPoolLimit: 10, leaseMs: LEASE_MS,
    });
    assert.deepEqual(
      continuation.map((row) => Number(row.block_number)),
      [101, 102, 103, 104, 105, 107]
    );
  });

  ['swap', 'delta'].forEach((kind) => it(`bounds each V4 ${kind} prefix and never crosses an earlier retry barrier`, async () => {
    const pool = 'robinhood:uniswap-v4:pool-a';
    const evidence = kind === 'delta' ? { event: { kind: 'modify-liquidity' } } : {};
    const seed = (input) => seedPending({ protocol: 'uniswap-v4', marketKey: pool, evidence, ...input });
    const first = await seed({ block: 100 });
    await seed({ block: 101 });
    const deferred = await seed({ block: 102, dueInMs: 3_600_000 });
    const afterDeferred = await seed({ block: 103 });
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
  }));

  it('never skips a locked V4 predecessor to claim its later deltas', async () => {
    const pool = 'robinhood:uniswap-v4:pool-a';
    const first = await seedPending({
      block: 100, protocol: 'uniswap-v4', marketKey: pool,
      evidence: { event: { kind: 'modify-liquidity' } },
    });
    await seedPending({
      block: 101, protocol: 'uniswap-v4', marketKey: pool,
      evidence: { event: { kind: 'modify-liquidity' } },
    });
    const blocker = await db.getClient();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM robinhood_head_captures
        WHERE transaction_hash = $1 AND log_index = $2 FOR UPDATE`,
      [first.transactionHash, first.logIndex]);
      assert.deepEqual(await repository.claimV4Continuations({
        owner: 'worker-a', marketKeys: [pool], limit: 10, leaseMs: LEASE_MS,
      }), []);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
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

  it('mirrors insert, lease and terminal lifecycle into the narrow shadow state', async () => {
    const identity = await seedPending({ block: 100 });
    let state = (await db.query(
      `SELECT processing_status, lease_owner, attempt_count,
              stream, protocol, market_key, block_number, transaction_index
         FROM robinhood_head_capture_states
        WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=$2`,
      [identity.transactionHash, identity.logIndex]
    )).rows[0];
    assert.deepEqual(state, {
      processing_status: 'pending', lease_owner: null, attempt_count: 0,
      stream: 'market', protocol: 'uniswap-v3',
      market_key: 'robinhood:uniswap-v3:test',
      block_number: '100', transaction_index: '0',
    });

    await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS });
    state = (await db.query(
      `SELECT processing_status, lease_owner, attempt_count
         FROM robinhood_head_capture_states
        WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=$2`,
      [identity.transactionHash, identity.logIndex]
    )).rows[0];
    assert.deepEqual(state, {
      processing_status: 'leased', lease_owner: 'worker-a', attempt_count: 1,
    });

    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, processed: [identity],
    });
    const parity = (await db.query(
      `SELECT capture.processing_status = state.processing_status
                AND capture.terminal_at = state.terminal_at
                AND capture.retention_eligible_at = state.retention_eligible_at
                AND capture.stream = state.stream
                AND capture.protocol IS NOT DISTINCT FROM state.protocol
                AND capture.market_key IS NOT DISTINCT FROM state.market_key
                AND capture.block_number = state.block_number
                AND capture.transaction_index = state.transaction_index AS matches
         FROM robinhood_head_captures capture
         JOIN robinhood_head_capture_states state
           USING (chain, transaction_hash, log_index)
        WHERE capture.chain='robinhood' AND capture.transaction_hash=$1
          AND capture.log_index=$2`,
      [identity.transactionHash, identity.logIndex]
    )).rows[0];
    assert.equal(parity.matches, true);
  });

  it('repairs active routing without touching historical terminal states', async () => {
    const terminal = await seedPending({ block: 99 });
    const active = await seedPending({
      block: 100, protocol: 'uniswap-v4', marketKey: 'robinhood:uniswap-v4:pool-a',
    });
    await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS });
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS, processed: [terminal],
    });
    await db.query(
      `UPDATE robinhood_head_capture_states
          SET stream=NULL, protocol=NULL, market_key=NULL,
              block_number=NULL, transaction_index=NULL`
    );
    const states = createRobinhoodHeadCaptureStateRepository({ database: db });
    await states.assertRoutingMirrorReady();
    const source = await states.describeRoutingPhysicalSource();
    const bounds = { startBlock: 0, endBlock: source.heapBlocks, statementTimeoutMs: 30_000 };
    const preview = await states.processRoutingPhysicalBatch({ ...bounds, write: false });
    assert.deepEqual([preview.candidates, preview.updated], [1, 0]);
    const written = await states.processRoutingPhysicalBatch({ ...bounds, write: true });
    assert.deepEqual([written.candidates, written.updated, written.divergent], [1, 1, 0]);
    const result = await db.query(
      `SELECT transaction_hash, stream, protocol, market_key, block_number
         FROM robinhood_head_capture_states ORDER BY block_number NULLS LAST`
    );
    assert.deepEqual(result.rows[0], {
      transaction_hash: active.transactionHash, stream: 'market',
      protocol: 'uniswap-v4', market_key: 'robinhood:uniswap-v4:pool-a',
      block_number: '100',
    });
    assert.equal(result.rows[1].transaction_hash, terminal.transactionHash);
    assert.equal(result.rows[1].stream, null);
    const clean = await states.auditRoutingPhysicalBatch(bounds);
    assert.deepEqual(
      [clean.active, clean.missingPayload, clean.divergent, clean.incomplete],
      [1, 0, 0, 0]
    );
    await db.query(
      `UPDATE robinhood_head_capture_states SET market_key='wrong', stream=NULL
        WHERE transaction_hash=$1 AND log_index=$2`,
      [active.transactionHash, active.logIndex]
    );
    const dirty = await states.auditRoutingPhysicalBatch(bounds);
    assert.deepEqual([dirty.active, dirty.divergent, dirty.incomplete], [1, 1, 1]);
  });

  it('backfills a bounded missing state and verifies lifecycle parity', async () => {
    const identity = await seedPending({ block: 100 });
    await db.query(
      `DELETE FROM robinhood_head_capture_states
        WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=$2`,
      [identity.transactionHash, identity.logIndex]
    );
    const states = createRobinhoodHeadCaptureStateRepository({ database: db });
    await states.assertMirrorReady();
    const preview = await states.processBatch({
      limit: 100, write: false, statementTimeoutMs: 30_000,
    });
    assert.deepEqual(
      [preview.scanned, preview.inserted, preview.missing, preview.divergent],
      [1, 0, 1, 0]
    );

    const written = await states.processBatch({
      limit: 100, write: true, statementTimeoutMs: 30_000,
    });
    assert.deepEqual(
      [written.scanned, written.inserted, written.missing, written.divergent, written.complete],
      [1, 1, 0, 0, true]
    );
  });

  it('backfills and audits a bounded physical heap range', async () => {
    const identity = await seedPending({ block: 100 });
    await db.query(
      `DELETE FROM robinhood_head_capture_states
        WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=$2`,
      [identity.transactionHash, identity.logIndex]
    );
    const states = createRobinhoodHeadCaptureStateRepository({ database: db });
    const source = await states.describePhysicalSource();
    assert.ok(source.heapBlocks > 0);
    assert.match(source.relationFileNode, /^\d+$/);

    const written = await states.processPhysicalBatch({
      startBlock: 0, endBlock: source.heapBlocks,
      write: true, statementTimeoutMs: 30_000,
    });
    assert.deepEqual(
      [written.scanned, written.inserted, written.missing, written.divergent],
      [1, 1, 0, 0]
    );
  });

  it('keeps retention from deleting a payload while its state is backfilled', async () => {
    const identity = await seedPending({ block: 100 });
    await db.query(
      `DELETE FROM robinhood_head_capture_states
        WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=$2`,
      [identity.transactionHash, identity.logIndex]
    );
    const gate = await db.getClient();
    const deleter = await db.getClient();
    const lockKey = 224103;
    let backfill;
    let deletion;
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [lockKey]);
      await db.query(
        `CREATE OR REPLACE FUNCTION test_block_head_state_insert()
         RETURNS trigger LANGUAGE plpgsql AS $function$
         BEGIN
           PERFORM pg_advisory_xact_lock(${lockKey});
           RETURN NEW;
         END
         $function$`
      );
      await db.query(
        `CREATE TRIGGER test_block_head_state_insert
         BEFORE INSERT ON robinhood_head_capture_states
         FOR EACH ROW EXECUTE FUNCTION test_block_head_state_insert()`
      );

      const states = createRobinhoodHeadCaptureStateRepository({ database: db });
      backfill = states.processBatch({
        limit: 100, write: true, statementTimeoutMs: 30_000,
      });
      assert.equal(await waitForActivity((row) => (
        row.wait_event === 'advisory' && row.query.includes('WITH batch AS MATERIALIZED')
      )), true);

      await deleter.query("SET application_name = 'head-state-retention-race-test'");
      deletion = deleter.query(
        `DELETE FROM robinhood_head_captures
          WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=$2`,
        [identity.transactionHash, identity.logIndex]
      );
      assert.equal(await waitForActivity((row) => (
        row.application_name === 'head-state-retention-race-test'
          && row.wait_event_type === 'Lock'
      )), true);

      await gate.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      const [written, removed] = await Promise.all([backfill, deletion]);
      assert.deepEqual(
        [written.scanned, written.inserted, written.missing, written.divergent],
        [1, 1, 0, 0]
      );
      assert.equal(removed.rowCount, 1);
    } finally {
      await gate.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
      await Promise.allSettled([backfill, deletion].filter(Boolean));
      await db.query(
        'DROP TRIGGER IF EXISTS test_block_head_state_insert ON robinhood_head_capture_states'
      );
      await db.query('DROP FUNCTION IF EXISTS test_block_head_state_insert()');
      gate.release();
      deleter.release();
    }
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
    const terminal = await statusOf(expired);
    assert.equal(terminal.retention_eligible_at - terminal.terminal_at, 259_200_000);
    await db.query(
      `UPDATE robinhood_head_captures
         SET terminal_at = NOW() - INTERVAL '4 days',
             retention_eligible_at = NOW() - INTERVAL '1 minute'
         WHERE transaction_hash = $1 AND log_index = $2`,
      [expired.transactionHash, expired.logIndex]
    );
    await db.query(
      `UPDATE robinhood_head_captures
         SET terminal_at = NOW() - INTERVAL '2 days',
             retention_eligible_at = NOW() - INTERVAL '1 minute'
         WHERE transaction_hash = $1 AND log_index = $2`,
      [fresh.transactionHash, fresh.logIndex]
    );

    const pruned = await repository.pruneExpiredCaptures({ limit: 100 });

    assert.equal(pruned, 1);
    assert.equal(await statusOf(expired), undefined);
    assert.equal((await statusOf(fresh)).processing_status, 'processed'); // three-day floor
    assert.equal((await statusOf(pending)).processing_status, 'pending'); // never terminal
  });

  it('suspends capture pruning while the targeted V3 archive repair holds its lock', async () => {
    const expired = await seedPending({ block: 103 });
    await repository.claimCaptures({ owner: 'worker-a', limit: 1, leaseMs: LEASE_MS });
    await repository.settleClaims({
      owner: 'worker-a', retentionMs: RETENTION_MS,
      processed: [expired],
    });
    await db.query(
      `UPDATE robinhood_head_captures
          SET terminal_at = NOW() - INTERVAL '4 days',
              retention_eligible_at = NOW() - INTERVAL '1 minute'
        WHERE transaction_hash = $1 AND log_index = $2`,
      [expired.transactionHash, expired.logIndex]
    );

    const lockClient = await db.getClient();
    try {
      await lockClient.query(
        "SELECT pg_advisory_lock(hashtext('robinhood:v3-pruned-capture-repair'))"
      );
      assert.equal(await repository.pruneExpiredCaptures({ limit: 100 }), 0);
      assert.equal((await statusOf(expired)).processing_status, 'processed');
    } finally {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtext('robinhood:v3-pruned-capture-repair'))"
      );
      lockClient.release();
    }
    assert.equal(await repository.pruneExpiredCaptures({ limit: 100 }), 1);
    assert.equal(await statusOf(expired), undefined);
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
