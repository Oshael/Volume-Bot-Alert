const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-retention-worker');
const VALID_WALLET_GATE = Object.freeze({
  valid: true,
  reason: null,
  completeThroughBlock: '900',
  sourceFrontierBlock: '905',
  updatedAt: new Date().toISOString(),
});
const EMPTY_REALTIME_TELEMETRY = Object.freeze({
  observedLagBlocks: null,
  finalizedLagBlocks: null,
});
const OPEN_ADMISSION = Object.freeze({
  allowed: true,
  reason: null,
  capturedThroughBlock: '1000',
  canonicalThroughBlock: '1000',
  canonicalLagBlocks: '0',
});

function dependencies(database, gate = VALID_WALLET_GATE) {
  return {
    database,
    loadMaintenanceAdmission: async () => OPEN_ADMISSION,
    watermarkRepository: { loadRetentionGate: async () => gate },
    headProcessingRepository: { pruneExpiredCaptures: async () => 0 },
    headCapturePruneState: { lastRunAtMs: null },
    realtimeOutboxRepository: {
      pruneTerminalCycles: async () => ({ scanned: 0, nextCursor: null, cycles: 0, rows: 0 }),
      loadTelemetry: async () => EMPTY_REALTIME_TELEMETRY,
    },
    realtimeOutboxPruneState: { cursor: null },
    realtimeOutboxTelemetryCache: { loadedAtMs: null, value: null },
    chainEventPruner: async () => ({
      status: 'finished', stopReason: 'prefix_drained',
      retentionMs: 3 * 24 * 60 * 60 * 1000, batches: 1, totalDeleted: 0,
    }),
  };
}

function createFakeDatabase(rawBatches = [], journalBatches = [], positionBatches = []) {
  const calls = [];
  return {
    calls,
    async queryWithStatementTimeout(sql, params, timeoutMs) {
      calls.push({ sql, params, timeoutMs });
      if (/DELETE FROM robinhood_processed_logs/.test(sql)) {
        const row = rawBatches.shift() || {
          examined: 0,
          processedLogs: 0,
          observations: 0,
        };
        return {
          rows: [{
            examined_logs: row.examined ?? row.processedLogs,
            processed_logs: row.processedLogs,
            observations: row.observations,
            wallet_protected: row.protectedByWallet,
            bucket_protected: row.protectedByBucketCoverage,
            aggregation_protected: row.protectedByAggregation,
            candidate_block_min: row.candidateBlockMin,
            candidate_block_max: row.candidateBlockMax,
          }],
        };
      }
      if (/DELETE FROM robinhood_wallet_transfer_reorg_journal/.test(sql)) {
        return { rows: [{ deleted: journalBatches.shift() || 0 }] };
      }
      if (/DELETE FROM robinhood_wallet_position_reorg_preimages/.test(sql)) {
        return { rows: [{ deleted: positionBatches.shift() || 0 }] };
      }
      throw new Error('Unexpected retention query');
    },
  };
}

describe('Robinhood retention worker', () => {
  it('continues past an ineligible page and preserves the seek cursor across ticks', async () => {
    const calls = [];
    const cursor = { createdAt: '2026-09-19T00:00:00Z', blockNumber: '1' };
    const pruneState = { cursor: null };
    const repository = {
      async pruneTerminalCycles(input) {
        calls.push(input.after);
        return calls.length === 1
          ? { scanned: 100, nextCursor: cursor, cycles: 0, rows: 0 }
          : { scanned: 1, nextCursor: cursor, cycles: 1, rows: 2 };
      },
      async loadTelemetry() { return EMPTY_REALTIME_TELEMETRY; },
    };
    const options = worker.__private.normalizeOptions({ batchLimit: 100, maxBatches: 1 });
    const deps = {
      realtimeOutboxRepository: repository, realtimeOutboxPruneState: pruneState,
      realtimeOutboxTelemetryCache: { loadedAtMs: null, value: null },
    };
    await worker.__private.maintainRealtimeOutbox({}, options, deps);
    assert.deepEqual(pruneState.cursor, cursor);
    await worker.__private.maintainRealtimeOutbox({}, options, deps);
    assert.deepEqual(calls, [null, cursor]);
    assert.equal(pruneState.cursor, null);
  });

  it('bounds cleanup load controls', () => {
    assert.deepEqual(worker.__private.normalizeOptions({
      intervalMs: 1,
      batchLimit: 1,
      maxBatches: 999,
      statementTimeoutMs: 1,
    }), {
      enabled: true,
      intervalMs: 10_000,
      batchLimit: 100,
      maxBatches: 50,
      statementTimeoutMs: 1000,
      realtimeOutboxRetentionMs: 3 * 24 * 60 * 60 * 1000,
      realtimeOutboxTelemetryIntervalMs: 5 * 60 * 1000,
      chainEventRetentionEnabled: true,
      chainEventPartitionRetentionEnabled: false,
      canonicalRawRetentionEnabled: false,
      positionPreimagePruneEnabled: false,
      chainEventRetentionMs: 3 * 24 * 60 * 60 * 1000,
      canonicalMaxLagBlocks: 128,
      capturePruneEnabled: true,
      capturePruneIntervalMs: 5 * 60 * 1000,
      capturePruneLimit: 5000,
    });
  });

  it('derives the canonical maintenance gate from the first unsettled block', () => {
    assert.deepEqual(worker.__private.evaluateMaintenanceAdmission({
      capture_next_block: '1001', first_unsettled_block: '900',
    }, 128), {
      allowed: true,
      reason: null,
      capturedThroughBlock: '1000',
      canonicalThroughBlock: '899',
      canonicalLagBlocks: '101',
    });
    assert.deepEqual(worker.__private.evaluateMaintenanceAdmission({
      capture_next_block: '1001', first_unsettled_block: '800',
    }, 128), {
      allowed: false,
      reason: 'canonical_lag_exceeded',
      capturedThroughBlock: '1000',
      canonicalThroughBlock: '799',
      canonicalLagBlocks: '201',
    });
    assert.deepEqual(worker.__private.evaluateMaintenanceAdmission({}, 128), {
      allowed: false, reason: 'canonical_cursor_missing',
    });
  });

  it('loads the canonical frontier with the retention statement timeout', async () => {
    const calls = [];
    const database = { queryWithStatementTimeout: async (sql, params, timeoutMs) => {
      calls.push({ sql, params, timeoutMs });
      return { rows: [{ capture_next_block: '1001', first_unsettled_block: '900' }] };
    } };
    const options = worker.__private.normalizeOptions({ statementTimeoutMs: 2500 });

    const admission = await worker.__private.loadMaintenanceAdmission(database, options, {});

    assert.equal(admission.allowed, true);
    assert.equal(admission.canonicalLagBlocks, '101');
    assert.equal(calls[0].timeoutMs, 2500);
    assert.match(calls[0].sql, /status<>'complete'/);
    assert.match(calls[0].sql, /ORDER BY block_number LIMIT 1/);
  });

  it('fails closed before every delete when canonical lag exceeds the budget', async () => {
    const database = createFakeDatabase();
    const deps = dependencies(database);
    deps.loadMaintenanceAdmission = async () => ({
      allowed: false,
      reason: 'canonical_lag_exceeded',
      capturedThroughBlock: '1000',
      canonicalThroughBlock: '799',
      canonicalLagBlocks: '201',
    });

    const summary = await worker.runOnce({}, {}, deps);

    assert.equal(summary.maintenanceAllowed, false);
    assert.equal(summary.maintenancePauseReason, 'canonical_lag_exceeded');
    assert.deepEqual(summary.headCaptures, { status: 'paused', deleted: 0 });
    assert.equal(summary.chainEvents.status, 'paused');
    assert.equal(database.calls.length, 0);
    assert.equal(worker.getStatus().lastMaintenanceAllowed, false);
    assert.equal(worker.getStatus().lastCanonicalLagBlocks, '201');
  });

  it('owns bounded head capture pruning and respects its cooldown', async () => {
    const database = createFakeDatabase();
    const deps = dependencies(database);
    let nowMs = 10_000;
    let calls = 0;
    deps.now = () => nowMs;
    const selectedRepository = deps.headProcessingRepository;
    delete deps.headProcessingRepository;
    let selections = 0;
    deps.headProcessingRepositorySelector = async () => {
      selections += 1;
      return selectedRepository;
    };
    selectedRepository.pruneExpiredCaptures = async ({ limit }) => {
      calls += 1;
      assert.equal(limit, 700);
      return 3;
    };
    const options = { capturePruneIntervalMs: 300_000, capturePruneLimit: 700 };

    const first = await worker.runOnce(options, {}, deps);
    nowMs += 299_999;
    const second = await worker.runOnce(options, {}, deps);

    assert.deepEqual(first.headCaptures, { status: 'completed', deleted: 3 });
    assert.deepEqual(second.headCaptures, { status: 'cooldown', deleted: 0 });
    assert.equal(calls, 1);
    assert.equal(selections, 1);
  });

  it('runs canonical raw pruning with a hard three-day minimum and preserves blockers', async () => {
    const database = createFakeDatabase();
    let received = null;
    const deps = dependencies(database);
    deps.chainEventPruner = async (options, nestedDeps) => {
      received = { options, database: nestedDeps.database };
      return {
        status: 'blocked', reason: 'retention_safety_audit', totalDeleted: 0,
        blockers: [{ code: 'capture_lag_exceeded' }],
      };
    };

    const summary = await worker.runOnce({
      batchLimit: 10_000,
      maxBatches: 2,
      chainEventRetentionMs: 1,
      chainEventPartitionRetentionEnabled: true,
      canonicalRawRetentionEnabled: true,
    }, {}, deps);

    assert.deepEqual(received, {
      options: {
        batchLimit: 5_000,
        maxBatches: 2,
        retentionMs: 3 * 24 * 60 * 60 * 1000,
        pruneCanonicalStorage: true,
        partitionDropEnabled: true,
      },
      database,
    });
    assert.equal(summary.chainEvents.status, 'blocked');
    assert.deepEqual(worker.getStatus().lastChainEventPruneBlockers, [
      { code: 'capture_lag_exceeded' },
    ]);
  });

  it('deletes expired raw rows through the cascading ledger in bounded batches', async () => {
    const database = createFakeDatabase(
      [
        { processedLogs: 100, observations: 80 },
        { processedLogs: 25, observations: 20 },
      ]
    );

    const summary = await worker.runOnce({
      batchLimit: 100,
      maxBatches: 5,
      statementTimeoutMs: 2500,
    }, {}, dependencies(database));

    assert.deepEqual(summary, {
      maintenanceAllowed: true,
      maintenancePauseReason: null,
      capturedThroughBlock: '1000',
      canonicalThroughBlock: '1000',
      canonicalLagBlocks: '0',
      batches: 2,
      examinedProcessedLogs: 125,
      processedLogs: 125,
      protectedProcessedLogs: 0,
      candidatesProtectedByWallet: 0,
      candidatesProtectedByBucketCoverage: 0,
      candidatesProtectedByAggregation: 0,
      retentionCandidateBlockMin: null,
      retentionCandidateBlockMax: null,
      walletGateValid: true,
      walletGateReason: null,
      walletCompleteThroughBlock: '900',
      walletWatermarkUpdatedAt: VALID_WALLET_GATE.updatedAt,
      walletWatermarkAgeMs: summary.walletWatermarkAgeMs,
      walletLagBlocks: '5',
      observations: 100,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
      transferReorgJournal: 0,
      positionPreimages: 0,
      realtimeOutboxRows: 0,
      realtimeOutboxCycles: 0,
      realtimeOutbox: EMPTY_REALTIME_TELEMETRY,
      chainEvents: {
        status: 'finished', stopReason: 'prefix_drained',
        retentionMs: 3 * 24 * 60 * 60 * 1000, batches: 1, totalDeleted: 0,
      },
      headCaptures: { status: 'completed', deleted: 0 },
    });
    assert.equal(database.calls.length, 3);
    assert.ok(database.calls.every((call) => call.params[0] === 100));
    assert.ok(database.calls.every((call) => call.timeoutMs === 2500));
    assert.match(database.calls[0].sql, /FOR UPDATE OF processed SKIP LOCKED/);
    assert.match(database.calls[0].sql, /expired_prefix AS MATERIALIZED/);
    assert.match(database.calls[0].sql,
      /FROM robinhood_processed_logs processed[\s\S]*LIMIT \$1::int[\s\S]*OFFSET \$3::int[\s\S]*FOR UPDATE/);
    assert.match(database.calls[0].sql,
      /FROM expired_prefix prefix[\s\S]*LEFT JOIN robinhood_market_observations/);
    assert.ok(
      database.calls[0].sql.indexOf('LIMIT $1::int')
        < database.calls[0].sql.indexOf('LEFT JOIN robinhood_market_observations')
    );
    assert.match(database.calls[0].sql, /robinhood_market_observations/);
    assert.match(database.calls[0].sql, /expired\.status = 'accepted'/);
    assert.match(database.calls[0].sql, /robinhood_market_buckets_1m minute/);
    assert.match(database.calls[0].sql, /robinhood_backfill_aggregation_outbox aggregation/);
    assert.match(database.calls[0].sql, /aggregation\.status <> 'completed'/);
    assert.match(database.calls[0].sql, /status = 'rejected'/);
    assert.match(database.calls[0].sql, /expired\.block_number <= \$2::bigint/);
    assert.match(database.calls[0].sql,
      /COUNT\(\*\) FILTER \(WHERE status IS NOT NULL\)::int AS observations/);
    assert.deepEqual(database.calls[0].params, [100, '900', 0]);
    assert.doesNotMatch(database.calls[0].sql, /status = 'pending'/);
  });

  it('never removes durable minute buckets', async () => {
    const database = createFakeDatabase([{ examined: 100, processedLogs: 100 }]);

    await worker.runOnce({ batchLimit: 100, maxBatches: 1 }, {}, dependencies(database));

    assert.equal(database.calls.some((call) => (
      /DELETE FROM robinhood_market_buckets_1m/.test(call.sql)
    )), false);
  });

  it('never removes permanent hourly buckets used by fallback and all-available reads', async () => {
    const database = createFakeDatabase();

    const summary = await worker.runOnce({
      batchLimit: 100, maxBatches: 1,
    }, {}, dependencies(database));

    assert.equal(summary.hourlyBuckets, 0);
    assert.equal(database.calls.some((call) => (
      /DELETE FROM robinhood_market_buckets_1h/.test(call.sql)
    )), false);
  });

  it('does not touch the database when retention is disabled', async () => {
    const database = createFakeDatabase();

    const summary = await worker.runOnce({ enabled: false }, {}, { database });

    assert.deepEqual(summary, {
      maintenanceAllowed: false,
      maintenancePauseReason: 'not_evaluated',
      capturedThroughBlock: null,
      canonicalThroughBlock: null,
      canonicalLagBlocks: null,
      batches: 0,
      examinedProcessedLogs: 0,
      processedLogs: 0,
      protectedProcessedLogs: 0,
      candidatesProtectedByWallet: 0,
      candidatesProtectedByBucketCoverage: 0,
      candidatesProtectedByAggregation: 0,
      retentionCandidateBlockMin: null,
      retentionCandidateBlockMax: null,
      walletGateValid: false,
      walletGateReason: 'not_evaluated',
      walletCompleteThroughBlock: null,
      walletWatermarkUpdatedAt: null,
      walletWatermarkAgeMs: null,
      walletLagBlocks: null,
      observations: 0,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
      transferReorgJournal: 0,
      positionPreimages: 0,
      realtimeOutboxRows: 0,
      realtimeOutboxCycles: 0,
      realtimeOutbox: null,
      chainEvents: null,
      headCaptures: { status: 'not_evaluated', deleted: 0 },
    });
    assert.equal(database.calls.length, 0);
  });

  it('stops raw deletion when an expired observation lacks coverage', async () => {
    const database = createFakeDatabase([
      {
        examined: 10,
        processedLogs: 6,
        observations: 6,
        protectedByWallet: 2,
        protectedByBucketCoverage: 1,
        protectedByAggregation: 1,
        candidateBlockMin: '899',
        candidateBlockMax: '901',
      },
    ]);

    const summary = await worker.runOnce({ batchLimit: 100 }, {}, dependencies(database));

    assert.equal(summary.protectedProcessedLogs, 4);
    assert.equal(summary.processedLogs, 6);
    assert.equal(summary.candidatesProtectedByWallet, 2);
    assert.equal(summary.candidatesProtectedByBucketCoverage, 1);
    assert.equal(summary.candidatesProtectedByAggregation, 1);
    assert.equal(summary.retentionCandidateBlockMin, '899');
    assert.equal(summary.retentionCandidateBlockMax, '901');
    assert.equal(summary.hourlyBuckets, 0);
    assert.equal(database.calls.length, 2);
  });

  it('continues bounded cleanup when a full prefix makes partial progress', async () => {
    const database = createFakeDatabase([
      {
        examined: 100,
        processedLogs: 91,
        observations: 91,
        protectedByBucketCoverage: 9,
      },
      { examined: 50, processedLogs: 50, observations: 50 },
    ]);

    const summary = await worker.runOnce({
      batchLimit: 100, maxBatches: 5,
    }, {}, dependencies(database));

    assert.equal(summary.batches, 2);
    assert.equal(summary.examinedProcessedLogs, 150);
    assert.equal(summary.processedLogs, 141);
    assert.equal(summary.protectedProcessedLogs, 9);
    assert.equal(summary.candidatesProtectedByBucketCoverage, 9);
    assert.equal(database.calls.length, 3);
    assert.deepEqual(database.calls[0].params, [100, '900', 0]);
    assert.deepEqual(database.calls[1].params, [100, '900', 9]);
  });

  it('scans behind a full protected prefix without weakening its gates', async () => {
    const database = createFakeDatabase([
      {
        examined: 100,
        processedLogs: 0,
        protectedByBucketCoverage: 100,
      },
      { examined: 25, processedLogs: 25, observations: 25 },
    ]);

    const summary = await worker.runOnce({
      batchLimit: 100, maxBatches: 5,
    }, {}, dependencies(database));

    assert.equal(summary.batches, 2);
    assert.equal(summary.processedLogs, 25);
    assert.equal(summary.protectedProcessedLogs, 100);
    assert.equal(summary.candidatesProtectedByBucketCoverage, 100);
    assert.deepEqual(database.calls[0].params, [100, '900', 0]);
    assert.deepEqual(database.calls[1].params, [100, '900', 100]);
  });

  it('fails closed for accepted rows when loading the wallet watermark fails', async () => {
    const database = createFakeDatabase([{
      examined: 8,
      processedLogs: 5,
      observations: 5,
      protectedByWallet: 3,
      candidateBlockMin: '901',
      candidateBlockMax: '903',
    }]);

    const summary = await worker.runOnce(
      { batchLimit: 100 },
      {},
      {
        ...dependencies(database),
        watermarkRepository: {
          loadRetentionGate: async () => { throw new Error('cursor read failed'); },
        },
      }
    );

    assert.equal(summary.walletGateValid, false);
    assert.equal(summary.walletGateReason, 'watermark_load_error');
    assert.equal(summary.candidatesProtectedByWallet, 3);
    assert.equal(summary.processedLogs, 5);
    assert.deepEqual(database.calls[0].params, [100, null, 0]);
    assert.match(database.calls[0].sql, /status = 'rejected'/);
    assert.match(database.calls[0].sql, /status = 'accepted' AND wallet_complete/);
    assert.equal(worker.getStatus().lastWalletGateValid, false);
    assert.equal(worker.getStatus().lastWalletGateReason, 'watermark_load_error');
    assert.equal(worker.getStatus().lastCandidatesProtectedByWallet, 3);
  });

  it('deletes only expired finalized transfer preimages in bounded batches', async () => {
    const database = createFakeDatabase([], [100, 25]);

    const summary = await worker.runOnce({
      batchLimit: 100, maxBatches: 5, statementTimeoutMs: 2500,
    }, {}, dependencies(database));

    assert.equal(summary.transferReorgJournal, 125);
    const calls = database.calls.filter(({ sql }) => (
      /DELETE FROM robinhood_wallet_transfer_reorg_journal/.test(sql)
    ));
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /journal\.expires_at <= NOW\(\)/);
    assert.match(calls[0].sql, /journal\.block_number <= cursor\.finalized_head/);
    assert.match(calls[0].sql, /FOR UPDATE OF journal SKIP LOCKED/);
    assert.deepEqual(calls[0].params, [100]);
  });

  it('prunes position preimages only when enabled, in bounded finalized batches', async () => {
    const disabled = createFakeDatabase();
    await worker.runOnce({ batchLimit: 100 }, {}, dependencies(disabled));
    assert.equal(disabled.calls.some(({ sql }) => (
      /DELETE FROM robinhood_wallet_position_reorg_preimages/.test(sql)
    )), false);

    const database = createFakeDatabase([], [], [100, 25]);
    const summary = await worker.runOnce({
      positionPreimagePruneEnabled: true,
      batchLimit: 100, maxBatches: 5, statementTimeoutMs: 2500,
    }, {}, dependencies(database));
    assert.equal(summary.positionPreimages, 125);
    const calls = database.calls.filter(({ sql }) => (
      /DELETE FROM robinhood_wallet_position_reorg_preimages/.test(sql)
    ));
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /preimage\.expires_at <= NOW\(\)/);
    assert.match(calls[0].sql, /preimage\.through_block <= cursor\.finalized_head/);
    assert.match(calls[0].sql, /FOR UPDATE OF preimage SKIP LOCKED/);
    assert.deepEqual(calls[0].params, [100]);
    assert.equal(calls[0].timeoutMs, 2500);
    assert.equal(worker.getStatus().lastDeletedPositionPreimages, 125);
  });

  it('reuses expensive realtime outbox telemetry between cleanup cycles', async () => {
    const database = createFakeDatabase();
    let nowMs = 1_000;
    let telemetryLoads = 0;
    const deps = dependencies(database);
    deps.now = () => nowMs;
    deps.realtimeOutboxRepository.loadTelemetry = async () => {
      telemetryLoads += 1;
      return EMPTY_REALTIME_TELEMETRY;
    };

    const options = {
      batchLimit: 100,
      maxBatches: 1,
      realtimeOutboxTelemetryIntervalMs: 300_000,
    };
    await worker.runOnce(options, {}, deps);
    nowMs += 299_999;
    await worker.runOnce(options, {}, deps);
    assert.equal(telemetryLoads, 1);

    nowMs += 1;
    await worker.runOnce(options, {}, deps);
    assert.equal(telemetryLoads, 2);
  });
});
