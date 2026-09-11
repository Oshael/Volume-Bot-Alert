const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSwapLiveWorker,
  __private: { buildRuntime },
} = require('../src/services/robinhood-wallet-swap-live-worker');
const {
  DURABLE_OUTBOX_SOURCE,
} = require('../src/services/robinhood-wallet-swap-live-source');

function result(status, overrides = {}) {
  return {
    status,
    nodeHead: '200',
    nodeSafeHead: '188',
    sourceSafeHead: '187',
    processableThrough: '187',
    nextBlock: '180',
    safeHead: '179',
    checkpointBlock: '179',
    processedBlocks: 0,
    attributed: 0,
    inserted: 0,
    unresolved: 0,
    missing: 0,
    ...overrides,
  };
}

function harness(outputs = []) {
  const scheduled = [];
  const fatals = [];
  const worker = createRobinhoodWalletSwapLiveWorker({
    schedule: (fn, delay) => {
      const entry = { fn, delay, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancelSchedule: (entry) => { entry.cancelled = true; },
    logger: { warn() {}, error() {} },
    runtimeFactory: async () => ({ providerChainIds: { 'robinhood-public': '4663' }, runnerDeps: {} }),
    runLiveTick: async () => {
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return output;
    },
  });
  return { worker, scheduled, fatals, onFatal: async (error) => fatals.push(error) };
}

describe('Robinhood wallet-swap LIVE worker', () => {
  it('stays disabled by default and schedules only when explicitly enabled', async () => {
    const context = harness([]);
    assert.equal(context.worker.start(), false);
    assert.equal(context.scheduled.length, 0);

    assert.equal(context.worker.start({ enabled: true }), true);
    assert.equal(context.scheduled.length, 1);
    assert.equal(context.scheduled[0].delay, 0);
    await context.worker.stop();
    assert.equal(context.scheduled[0].cancelled, true);
  });

  it('treats an absent bootstrap cursor as healthy and exposes bounded telemetry', async () => {
    const context = harness([result('awaiting-bootstrap', {
      nextBlock: null, safeHead: null, checkpointBlock: null,
    })]);
    context.worker.start({ enabled: true, onFatal: context.onFatal });
    await context.scheduled[0].fn();

    const status = context.worker.getStatus();
    assert.equal(status.halted, false);
    assert.equal(status.lastResult.status, 'awaiting-bootstrap');
    assert.equal(status.providerChainIds['robinhood-public'], '4663');
    assert.equal(status.lastError, null);
    assert.equal(context.fatals.length, 0);
    await context.worker.stop();
  });

  it('halts the lease after the same unresolved block reaches its configured limit', async () => {
    const blocked = () => result('blocked-unresolved', {
      failedBlock: '181', unresolved: 1, missing: 1,
    });
    const context = harness([blocked(), blocked()]);
    context.worker.start({
      enabled: true, maxConsecutiveFailures: 2, onFatal: context.onFatal,
    });
    await context.scheduled[0].fn();
    assert.equal(context.worker.getStatus().halted, false);
    assert.equal(context.worker.getStatus().lastError.code, 'wallet_attribution_unresolved');
    assert.equal(context.scheduled[1].delay, 4000);
    await context.scheduled[1].fn();

    const status = context.worker.getStatus();
    assert.equal(status.halted, true);
    assert.equal(status.running, false);
    assert.equal(status.lastError.code, 'wallet_attribution_blocked');
    assert.equal(context.fatals[0].fatal, true);
  });

  it('halts immediately on a persistent reorg', async () => {
    const error = new Error('checkpoint diverged');
    error.code = 'persistent_reorg';
    error.fatal = true;
    const context = harness([error]);
    context.worker.start({ enabled: true, onFatal: context.onFatal });
    await context.worker.runOnce();

    assert.equal(context.worker.getStatus().halted, true);
    assert.equal(context.fatals[0], error);
  });

  it('builds real runner dependencies on the shared Robinhood RPC contract', async () => {
    const calls = [];
    let attributorInput;
    const client = {
      request: async (method, params = []) => {
        calls.push({ method, params });
        return { method, params };
      },
    };
    const cursor = { loadCursor() {}, advanceLiveCursor() {} };
    const reader = { readAcceptedBlockGroups() {} };
    const frontierCalls = [];
    const marketRepository = {
      loadCursor: async () => ({ next_block: '190' }),
      resolveMarketFrontier: async (pendingBlock) => {
        frontierCalls.push(pendingBlock);
        return { nextBlock: pendingBlock == null ? '999' : String(pendingBlock) };
      },
    };
    const headProcessingRepository = {
      getOldestActiveCapture: async (stream) => {
        assert.equal(stream, 'market');
        return { blockNumber: '150' };
      },
    };
    const attributor = { attributeGroups() {} };
    const runtime = await buildRuntime({
      rpcOptions: {}, reorgDepth: 12, maxBlocks: 200, blockConcurrency: 6,
    }, {
      clientFactory: () => client,
      validateChainIds: async (value) => {
        assert.equal(value, client);
        return { local: '4663' };
      },
      walletRepositoryFactory: () => ({ insertWalletSwaps() {} }),
      transactionPositionRepositoryFactory: () => ({ upsertPositions() {} }),
      cursorFactory: () => cursor,
      sourceReaderFactory: () => reader,
      marketRepositoryFactory: () => marketRepository,
      headProcessingRepositoryFactory: () => headProcessingRepository,
      attributorFactory: (input) => {
        attributorInput = input;
        return attributor;
      },
    });

    assert.equal(runtime.runnerDeps.cursor, cursor);
    assert.equal(runtime.sourceMode, 'rpc');
    assert.equal(runtime.runnerDeps.reader, reader);
    assert.equal(runtime.runnerDeps.attributor, attributor);
    assert.equal(attributorInput.parserVersion, 'rh-wallet-live-1');
    assert.equal(attributorInput.fetchConcurrency, 6);
    assert.equal(typeof attributorInput.transactionPositionRepository.upsertPositions, 'function');
    await runtime.runnerDeps.readNodeHead();
    await runtime.runnerDeps.fetchBlockHeader('10');
    await attributorInput.fetchBlock('11');
    assert.deepEqual(calls, [
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_getBlockByNumber', params: ['0xa', false] },
      { method: 'eth_getBlockByNumber', params: ['0xb', true] },
    ]);

    // Regression: the market frontier must come from the strict processing
    // watermark (oldest active capture -> resolveMarketFrontier), never the
    // frozen monolith robinhood_ingestion_cursors that pinned the live cursor.
    const frontier = await runtime.runnerDeps.loadMarketCursor();
    assert.deepEqual(frontier, { nextBlock: '150' });
    assert.deepEqual(frontierCalls, ['150']);
  });

  it('uses the canonical journal without constructing an RPC client', async () => {
    const source = {
      loadBlock: async () => ({ full: true }),
      loadHeader: async () => ({ header: true }),
      readHead: async () => '200',
    };
    let attributorInput;
    const runtime = await buildRuntime({
      sourceMode: 'canonical_journal', rpcOptions: {}, reorgDepth: 12,
      maxBlocks: 200, blockConcurrency: 6,
    }, {
      clientFactory: () => { throw new Error('RPC must not be constructed'); },
      canonicalBlockSourceFactory: () => source,
      walletRepositoryFactory: () => ({ insertWalletSwaps() {} }),
      transactionPositionRepositoryFactory: () => ({ upsertPositions() {} }),
      cursorFactory: () => ({ loadCursor() {}, advanceLiveCursor() {} }),
      sourceReaderFactory: () => ({ readAcceptedBlockGroups() {} }),
      marketRepositoryFactory: () => ({ resolveMarketFrontier: async () => null }),
      headProcessingRepositoryFactory: () => ({ getOldestActiveCapture: async () => null }),
      attributorFactory: (input) => { attributorInput = input; return { attributeGroups() {} }; },
    });

    assert.equal(runtime.sourceMode, 'canonical_journal');
    assert.deepEqual(runtime.providerChainIds, { canonical_journal: '4663' });
    assert.equal(await runtime.runnerDeps.readNodeHead(), '200');
    assert.deepEqual(await runtime.runnerDeps.fetchBlockHeader('100'), { header: true });
    assert.deepEqual(await attributorInput.fetchBlock('100'), { full: true });
  });

  it('builds the durable consumer without constructing an RPC or block reader', async () => {
    const database = { query() {} };
    const outbox = {
      discardLegacyCovered: async () => 17,
      advanceCompatibilityWatermark: async () => '200',
      readFinalizedBlock: async () => '200',
      reclaimExpired() {}, claimFinalized() {}, settle() {},
    };
    const lifecycle = { promoteFinalized() {} };
    let runnerInput;
    let auditInput;
    const execution = [];
    const runtime = await buildRuntime({
      sourceMode: DURABLE_OUTBOX_SOURCE,
      outboxBatchSize: 300, outboxLeaseMs: 45000, outboxMaxAttempts: 7,
    }, {
      database,
      clientFactory: () => { throw new Error('RPC must not be constructed'); },
      canonicalBlockSourceFactory: () => { throw new Error('block reader must not be constructed'); },
      outboxRepositoryFactory: (options) => {
        assert.equal(options.database, database);
        return outbox;
      },
      realtimeOutboxRepositoryFactory: (options) => {
        assert.equal(options.database, database);
        return lifecycle;
      },
      walletRepositoryFactory: () => ({ insertWalletSwaps() {} }),
      transactionPositionRepositoryFactory: () => ({ upsertPositions() {} }),
      outboxRunnerFactory: (input) => {
        runnerInput = input;
        return { runOnce: async () => {
          execution.push('delivery');
          return { status: 'idle', claimed: 0 };
        } };
      },
      realtimeAuditRunnerFactory: (input) => {
        auditInput = input;
        return { runOnce: async () => {
          execution.push('audit');
          throw new Error('shadow unavailable');
        } };
      },
      marketTradeRealtime: { publishRows() {} },
    });

    assert.equal(runtime.sourceMode, DURABLE_OUTBOX_SOURCE);
    assert.equal(runtime.legacyDiscarded, 17);
    assert.equal(runnerInput.repository, outbox);
    assert.equal(runnerInput.lifecycleRepository, lifecycle);
    assert.equal(runnerInput.readFinalizedBlock, outbox.readFinalizedBlock);
    assert.equal(auditInput.repository, lifecycle);
    assert.deepEqual(auditInput.options, {
      batchSize: 300, leaseMs: 45000, maxAttempts: 7,
    });
    assert.deepEqual(runnerInput.options, {
      batchSize: 300, leaseMs: 45000, maxAttempts: 7,
    });
    const output = await runtime.runOnce();
    assert.equal(output.status, 'idle');
    assert.equal(output.completeThroughBlock, '200');
    assert.equal(output.audit.status, 'error');
    assert.match(output.audit.error.message, /shadow unavailable/);
    assert.deepEqual(execution, ['delivery', 'audit']);
  });

  it('wakes the durable consumer from outbox and finality notifications', async () => {
    const scheduled = [];
    const listeners = [];
    const worker = createRobinhoodWalletSwapLiveWorker({
      schedule: (fn, delay) => {
        const task = { fn, delay, cancelled: false };
        scheduled.push(task);
        return task;
      },
      cancelSchedule: (task) => { task.cancelled = true; },
      listenerFactory: (options) => {
        const listener = { options, stopped: false };
        listeners.push(listener);
        return {
          async start() {},
          async stop() { listener.stopped = true; },
        };
      },
      runtimeFactory: async () => ({
        sourceMode: DURABLE_OUTBOX_SOURCE, runOnce: async () => ({ status: 'idle', claimed: 0 }),
      }),
      logger: { warn() {}, error() {} },
    });

    assert.equal(worker.start({ enabled: true, sourceMode: DURABLE_OUTBOX_SOURCE }), true);
    assert.deepEqual(listeners.map((item) => item.options.channel).sort(), [
      'robinhood_chain_capture', 'robinhood_wallet_swap_outbox',
      'robinhood_wallet_swap_realtime_outbox',
    ]);
    listeners[0].options.onNotification();
    assert.equal(scheduled[0].cancelled, true);
    assert.equal(scheduled.at(-1).delay, 0);
    await worker.stop();
    assert.equal(listeners.every((item) => item.stopped), true);
  });

  it('immediately drains another lifecycle batch when promotion reaches its bound', async () => {
    const scheduled = [];
    const worker = createRobinhoodWalletSwapLiveWorker({
      schedule: (fn, delay) => {
        const task = { fn, delay, cancelled: false };
        scheduled.push(task);
        return task;
      },
      cancelSchedule: (task) => { task.cancelled = true; },
      listenerFactory: () => ({ async start() {}, async stop() {} }),
      runtimeFactory: async () => ({
        sourceMode: DURABLE_OUTBOX_SOURCE,
        runOnce: async () => ({ status: 'idle', promoted: 200, claimed: 0 }),
      }),
      logger: { warn() {}, error() {} },
    });

    worker.start({
      enabled: true, sourceMode: DURABLE_OUTBOX_SOURCE, outboxBatchSize: 200,
    });
    await scheduled[0].fn();
    assert.equal(scheduled.at(-1).delay, 0);
    await worker.stop();
  });

  it('immediately checks for terminals unlocked by any shadow-audit batch', async () => {
    const scheduled = [];
    const worker = createRobinhoodWalletSwapLiveWorker({
      schedule: (fn, delay) => {
        const task = { fn, delay, cancelled: false };
        scheduled.push(task);
        return task;
      },
      cancelSchedule: (task) => { task.cancelled = true; },
      listenerFactory: () => ({ async start() {}, async stop() {} }),
      runtimeFactory: async () => ({
        sourceMode: DURABLE_OUTBOX_SOURCE,
        runOnce: async () => ({
          status: 'idle', claimed: 0,
          audit: { status: 'audited', saturated: false, claimed: 1, audited: 1 },
        }),
      }),
      logger: { warn() {}, error() {} },
    });
    worker.start({ enabled: true, sourceMode: DURABLE_OUTBOX_SOURCE });
    await scheduled[0].fn();
    assert.equal(scheduled.at(-1).delay, 0);
    assert.equal(worker.getStatus().audited, 1);
    await worker.stop();
  });
});
