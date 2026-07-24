process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodBackfillCaptureRepository,
} = require('../src/models/robinhood-backfill-capture');
const stage82 = require('../src/utils/db-init-stage82');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;
const TOPIC = `0x${'d'.repeat(64)}`;
const CHECKPOINT_AT = '2026-07-23T12:00:00.000Z';

function buildLog(blockNumber, logIndex = 0) {
  return {
    transactionHash: logIndex ? HASH_B : HASH_A,
    logIndex,
    blockNumber,
    blockHash: HASH_B,
    transactionIndex: 0,
    address: ADDRESS,
    topics: [TOPIC],
    data: '0x',
    protocol: 'uniswap-v3',
    marketKey: 'robinhood:uniswap-v3:test',
  };
}

function buildRange(fromBlock, toBlock, logs = []) {
  return {
    fromBlock,
    toBlock,
    provider: 'integration-test',
    decoderVersion: 'test-v1',
    rawLogCount: logs.length,
    logs,
    checkpoint: { hash: HASH_A, timestamp: CHECKPOINT_AT },
    fetchStartedAt: CHECKPOINT_AT,
    fetchFinishedAt: CHECKPOINT_AT,
  };
}

async function clearCaptureTables() {
  await db.query('DELETE FROM robinhood_market_log_staging');
  await db.query('DELETE FROM robinhood_backfill_watermarks');
  await db.query('DELETE FROM robinhood_backfill_ranges');
}

describe('Robinhood backfill capture repository integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage82.init({ closePool: false });
  });

  beforeEach(clearCaptureTables);

  after(async () => {
    await clearCaptureTables().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('captures set-based logs once and treats a replay as an idempotent duplicate', async () => {
    const repository = createRobinhoodBackfillCaptureRepository();
    const input = buildRange(100, 109, [buildLog(101), buildLog(108, 1)]);

    const first = await repository.captureMarketRange(input);
    const replay = await repository.captureMarketRange(input);
    const counts = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM robinhood_backfill_ranges) AS ranges,
         (SELECT COUNT(*) FROM robinhood_market_log_staging) AS logs`
    );

    assert.deepEqual(
      { insertedLogs: first.insertedLogs, duplicate: first.duplicate },
      { insertedLogs: 2, duplicate: false }
    );
    assert.equal(replay.duplicate, true);
    assert.equal(replay.insertedLogs, 0);
    assert.equal(Number(counts.rows[0].ranges), 1);
    assert.equal(Number(counts.rows[0].logs), 2);
  });

  it('captures an empty range and advances the durable scan watermark', async () => {
    const repository = createRobinhoodBackfillCaptureRepository();

    const captured = await repository.captureMarketRange(buildRange(200, 209));
    const watermark = await repository.loadMarketScanWatermark();

    assert.equal(captured.insertedLogs, 0);
    assert.equal(captured.watermarkAdvanced, true);
    assert.equal(watermark.nextBlock, '210');
    assert.equal(watermark.checkpointBlock, '209');
    assert.equal(watermark.version, '1');

    await assert.rejects(
      repository.captureMarketRange(buildRange(220, 229)),
      /range is not contiguous/
    );
    const ranges = await db.query('SELECT COUNT(*) FROM robinhood_backfill_ranges');
    assert.equal(Number(ranges.rows[0].count), 1);
    assert.equal((await repository.loadMarketScanWatermark()).nextBlock, '210');
  });

  it('rolls back staging, manifest and watermark when finalization fails', async () => {
    const failingDatabase = {
      query: (...args) => db.query(...args),
      async getClient() {
        const client = await db.getClient();
        return {
          release: () => client.release(),
          query(sql, params) {
            if (String(sql).includes('UPDATE robinhood_backfill_ranges')) {
              throw new Error('injected finalization failure');
            }
            return client.query(sql, params);
          },
        };
      },
    };
    const repository = createRobinhoodBackfillCaptureRepository({ database: failingDatabase });

    await assert.rejects(
      repository.captureMarketRange(buildRange(300, 309, [buildLog(301)])),
      /injected finalization failure/
    );
    const counts = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM robinhood_backfill_ranges) AS ranges,
         (SELECT COUNT(*) FROM robinhood_market_log_staging) AS logs,
         (SELECT COUNT(*) FROM robinhood_backfill_watermarks) AS watermarks`
    );
    assert.deepEqual(
      Object.values(counts.rows[0]).map(Number),
      [0, 0, 0]
    );
  });

  it('restores watermark and backlog state through a new repository instance', async () => {
    const firstProcess = createRobinhoodBackfillCaptureRepository();
    await firstProcess.captureMarketRange(buildRange(400, 409, [buildLog(405)]));

    const restartedProcess = createRobinhoodBackfillCaptureRepository();
    const watermark = await restartedProcess.loadMarketScanWatermark();
    const backlog = await restartedProcess.getBacklogSummary();
    const replay = await restartedProcess.captureMarketRange(
      buildRange(400, 409, [buildLog(405)])
    );

    assert.equal(watermark.nextBlock, '410');
    assert.deepEqual(backlog, {
      pending: 1,
      ready: 1,
      coolingDown: 0,
      leased: 0,
      activeLeases: 0,
      expiredLeases: 0,
      blocked: 0,
      terminal: 0,
      oldestOpenBlock: '405',
      oldestReadyBlock: '405',
      maxAttemptCount: 0,
    });
    assert.equal(replay.duplicate, true);
  });

  it('claims disjoint batches for concurrent owners with SKIP LOCKED', async () => {
    const repository = createRobinhoodBackfillCaptureRepository();
    await repository.captureMarketRange(buildRange(
      500, 509, [0, 1, 2, 3].map((index) => buildLog(501 + index, index))
    ));

    const [first, second] = await Promise.all([
      repository.claimEnrichmentBatch({ owner: 'worker-a', limit: 2 }),
      repository.claimEnrichmentBatch({ owner: 'worker-b', limit: 2 }),
    ]);
    const identities = [...first, ...second]
      .map((claim) => `${claim.transactionHash}:${claim.logIndex}`);

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(new Set(identities).size, 4);
    assert.deepEqual((await repository.getBacklogSummary()), {
      pending: 0,
      ready: 0,
      coolingDown: 0,
      leased: 4,
      activeLeases: 4,
      expiredLeases: 0,
      blocked: 0,
      terminal: 0,
      oldestOpenBlock: '501',
      oldestReadyBlock: null,
      maxAttemptCount: 1,
    });
  });

  it('reclaims an expired lease without accepting a stale owner result', async () => {
    const repository = createRobinhoodBackfillCaptureRepository();
    await repository.captureMarketRange(buildRange(600, 609, [buildLog(601)]));
    const [staleClaim] = await repository.claimEnrichmentBatch({ owner: 'stale-owner' });
    await db.query(
      `UPDATE robinhood_market_log_staging
       SET lease_until = NOW() - INTERVAL '1 second'`
    );

    const [reclaimed] = await repository.claimEnrichmentBatch({ owner: 'new-owner' });
    const staleResult = await repository.settleEnrichmentClaims({
      owner: 'stale-owner',
      claims: [staleClaim],
      outcome: 'completed',
    });

    assert.equal(reclaimed.transactionHash, staleClaim.transactionHash);
    assert.equal(reclaimed.attemptCount, 2);
    assert.deepEqual(staleResult, []);
  });

  it('cools down transient failures and blocks a poison item at max attempts', async () => {
    const repository = createRobinhoodBackfillCaptureRepository();
    await repository.captureMarketRange(buildRange(700, 709, [buildLog(701)]));
    const [first] = await repository.claimEnrichmentBatch({ owner: 'worker-a' });
    const [pending] = await repository.failEnrichmentClaims({
      owner: 'worker-a',
      claims: [first],
      error: 'temporary RPC failure',
      retryDelayMs: 60_000,
      maxAttempts: 2,
    });

    assert.equal(pending.status, 'pending');
    assert.equal((await repository.getBacklogSummary()).coolingDown, 1);
    await db.query(
      `UPDATE robinhood_market_log_staging
       SET next_attempt_at = NOW() - INTERVAL '1 second'`
    );
    const [second] = await repository.claimEnrichmentBatch({ owner: 'worker-b' });
    const [blocked] = await repository.failEnrichmentClaims({
      owner: 'worker-b',
      claims: [second],
      error: 'permanent poison item',
      retryDelayMs: 60_000,
      maxAttempts: 2,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal((await repository.getBacklogSummary()).blocked, 1);
  });

  it('renews active claims and releases unfinished work during graceful shutdown', async () => {
    const repository = createRobinhoodBackfillCaptureRepository();
    await repository.captureMarketRange(
      buildRange(800, 809, [buildLog(801), buildLog(802, 1)])
    );
    const claims = await repository.claimEnrichmentBatch({ owner: 'worker-a', limit: 2 });
    const renewed = await repository.renewEnrichmentClaims({
      owner: 'worker-a', claims, leaseMs: 120_000,
    });
    const released = await repository.releaseEnrichmentClaims({ owner: 'worker-a' });
    const reclaimed = await repository.claimEnrichmentBatch({ owner: 'worker-b', limit: 2 });
    const completed = await repository.settleEnrichmentClaims({
      owner: 'worker-b', claims: [reclaimed[0]], outcome: 'completed',
    });
    const rejected = await repository.settleEnrichmentClaims({
      owner: 'worker-b', claims: [reclaimed[1]], outcome: 'rejected',
    });

    assert.equal(renewed.length, 2);
    assert.equal(released.length, 2);
    assert.equal(reclaimed.length, 2);
    assert.equal(completed[0].status, 'completed');
    assert.equal(rejected[0].status, 'rejected');
    assert.equal((await repository.getBacklogSummary()).terminal, 2);
  });
});
