const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CANONICAL_CAPTURE_NOTIFY_CHANNEL, CANONICAL_SOURCE, CURSOR_NOTIFY_CHANNEL, RPC_SOURCE,
  createRobinhoodWalletSignedOriginLiveWorker,
  __private: { buildRuntime, normalizeSource },
} = require('../src/services/robinhood-wallet-signed-origin-live-worker');

function harness(outputs = []) {
  const scheduled = []; const fatals = []; let notification; let notificationChannel;
  let listenerStopped = false;
  const worker = createRobinhoodWalletSignedOriginLiveWorker({
    runtime: {}, now: () => Date.parse('2026-08-30T12:00:00Z'),
    schedule(fn, delay) { const item = { fn, delay, cancelled: false }; scheduled.push(item); return item; },
    cancelSchedule(item) { item.cancelled = true; },
    listenerFactory(input) { notification = input.onNotification;
      notificationChannel = input.channel; return {
      start() {}, stop() { listenerStopped = true; },
    }; },
    logger: { warn() {}, error() {} },
    runLiveTick: async () => { const value = outputs.shift();
      if (value instanceof Error) throw value; return value; },
  });
  return { fatals, get notification() { return notification; },
    get notificationChannel() { return notificationChannel; }, get listenerStopped() {
    return listenerStopped;
  }, onFatal: async (error) => fatals.push(error), scheduled, worker };
}

describe('Robinhood signed-origin LIVE worker', () => {
  it('is opt-in and wakes immediately from the committed head notification', async () => {
    const context = harness([{ status: 'caught_up', blocksCommitted: 0, originsWritten: 0 }]);
    assert.equal(context.worker.start(), false);
    assert.equal(context.worker.start({ enabled: true }), true);
    assert.equal(CURSOR_NOTIFY_CHANNEL, 'robinhood_head_capture_cursor');
    assert.equal(context.scheduled[0].delay, 0);
    context.notification();
    assert.equal(context.scheduled[0].cancelled, true);
    assert.equal(context.scheduled[1].delay, 0);
    await context.scheduled[1].fn();
    assert.equal(context.worker.getStatus().wakeups, 1);
    await context.worker.stop(); assert.equal(context.listenerStopped, true);
  });

  it('treats an incomplete seed as healthy and bounds transient failures with a circuit', async () => {
    const seed = Object.assign(new Error('seed incomplete'), { code: 'signed_origin_seed_incomplete' });
    const transient = new Error('rpc timeout');
    const context = harness([seed, transient, transient]);
    context.worker.start({ enabled: true, circuitFailureThreshold: 2, circuitResetMs: 60_000 });
    assert.equal((await context.worker.runOnce()).status, 'awaiting_seed');
    assert.equal(context.worker.getStatus().consecutiveFailures, 0);
    assert.equal(await context.worker.runOnce(), null);
    assert.equal(await context.worker.runOnce(), null);
    assert.equal(context.worker.getStatus().circuitOpen, true);
    assert.equal((await context.worker.runOnce()).status, 'circuit_open');
    await context.worker.stop();
  });

  it('halts itself and propagates persistent reorg to the durable lease', async () => {
    const error = Object.assign(new Error('checkpoint changed'), {
      code: 'persistent_reorg', fatal: true,
    });
    const context = harness([error]);
    context.worker.start({ enabled: true, onFatal: context.onFatal });
    assert.equal(await context.worker.runOnce(), null);
    assert.equal(context.worker.getStatus().halted, true);
    assert.equal(context.worker.getStatus().running, false);
    assert.equal(context.fatals[0], error);
  });

  it('builds against the VPS RPC and the committed discovery head only', async () => {
    let rpcOptions; let readerOptions; const queries = [];
    const database = { query: async (sql) => { queries.push(sql); return { rows: [{ safe_head: '123' }] }; } };
    const rpcClient = { request: async (method, params) => ({ method, params }) };
    const repository = {};
    const runtime = await buildRuntime({ sourceMode: RPC_SOURCE, maxBlocks: 40, rpcBatchSize: 10,
      concurrency: 2, timeoutMs: 5000, rpcOptions: { rpcMaxRetries: 1 } }, {
      database, env: { ROBINHOOD_RPC_URL: 'http://vps-node' },
      rpcClientFactory(options) { rpcOptions = options; return rpcClient; },
      repositoryFactory: () => repository,
      readerFactory(options) { readerOptions = options; return {}; },
    });
    assert.equal(runtime.repository, repository);
    assert.equal(runtime.sourceMode, RPC_SOURCE);
    assert.equal(rpcOptions.publicRpcUrl, 'http://vps-node');
    assert.equal(rpcOptions.useAlchemy, false); assert.equal(rpcOptions.useDrpc, false);
    assert.deepEqual({ rpcBatchSize: readerOptions.rpcBatchSize,
      concurrency: readerOptions.concurrency, maxBlocks: readerOptions.maxBlocks }, {
      rpcBatchSize: 10, concurrency: 2, maxBlocks: 40,
    });
    assert.deepEqual(await runtime.loadSourceFrontier(), { safeHead: '123' });
    assert.match(queries[0], /stream = 'discovery'/);
    assert.deepEqual(await runtime.fetchBlockHeader('16'), {
      method: 'eth_getBlockByNumber', params: ['0x10', false],
    });
  });

  it('builds canonical mode without requiring an RPC endpoint', async () => {
    const calls = [];
    const source = {
      async assertChain() { calls.push('chain'); },
      async getSafeHead(confirmations) { calls.push(confirmations); return { safeHead: '123' }; },
      async loadHeader(number) { return { number, hash: `0x${'a'.repeat(64)}` }; },
      async readBlocks() {},
    };
    const runtime = await buildRuntime({
      sourceMode: CANONICAL_SOURCE, confirmations: 2, maxBlocks: 40,
    }, { env: {}, canonicalSource: source, repositoryFactory: () => ({}) });
    assert.equal(runtime.sourceMode, CANONICAL_SOURCE);
    assert.equal(runtime.reader, source);
    assert.deepEqual(await runtime.loadSourceFrontier(), { safeHead: '123' });
    assert.deepEqual(calls, ['chain', 2]);
    assert.equal(normalizeSource(), RPC_SOURCE);
    assert.throws(() => normalizeSource('invalid'), /must be rpc or canonical_journal/);
  });

  it('wakes canonical mode from the committed canonical capture channel', async () => {
    const context = harness([]);
    context.worker.start({ enabled: true, sourceMode: CANONICAL_SOURCE });
    assert.equal(context.notificationChannel, CANONICAL_CAPTURE_NOTIFY_CHANNEL);
    await context.worker.stop();
  });
});
