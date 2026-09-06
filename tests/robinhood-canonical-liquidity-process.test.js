'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LEASE_KEY, assertCanonicalReady, liquidityRpcOptions, main,
} = require('../src/utils/run-robinhood-canonical-liquidity-worker');

function readyDatabase({ schema = true, leases = [] } = {}) {
  return {
    pool: {},
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return { rows: [{ refresh_queue: schema ? 'robinhood_pool_liquidity_refresh_queue' : null }] };
      }
      if (sql.includes('FROM worker_leases')) return { rows: leases };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const READY_LEASES = [
  { lease_key: 'robinhood-chain-capture-worker', metadata: { mode: 'shadow_receipts' } },
  { lease_key: 'robinhood-canonical-head-worker', metadata: { mode: 'canonical_publish' } },
];

test('canonical liquidity RPC accepts only an explicit loopback endpoint', () => {
  const options = liquidityRpcOptions({
    rpcUrl: 'http://127.0.0.1:8547', rpcTimeoutMs: 5000,
  }, { useAlchemy: true, useDrpc: true, rpcMinIntervalMs: 25 });
  assert.deepEqual({
    url: options.publicRpcUrl, timeout: options.rpcTimeoutMs,
    alchemy: options.useAlchemy, drpc: options.useDrpc,
    retries: options.rpcMaxRetries, interval: options.rpcMinIntervalMs,
  }, {
    url: 'http://127.0.0.1:8547/', timeout: 5000,
    alchemy: false, drpc: false, retries: 0, interval: 0,
  });
  assert.throws(
    () => liquidityRpcOptions({ rpcUrl: 'https://public.example' }, {}),
    (error) => error.code === 'configuration_error'
  );
});

test('canonical liquidity startup gate excludes legacy and requires canonical authorities', async () => {
  await assert.doesNotReject(assertCanonicalReady(readyDatabase({ leases: READY_LEASES })));
  await assert.rejects(
    assertCanonicalReady(readyDatabase({ schema: false, leases: READY_LEASES })),
    (error) => error.code === 'canonical_liquidity_schema_missing'
  );
  await assert.rejects(assertCanonicalReady(readyDatabase({ leases: [
    ...READY_LEASES, { lease_key: 'robinhood-pool-liquidity-worker', metadata: {} },
  ] })), (error) => error.code === 'legacy_liquidity_still_active');
  await assert.rejects(
    assertCanonicalReady(readyDatabase({ leases: READY_LEASES.slice(1) })),
    (error) => error.code === 'canonical_capture_inactive'
  );
  await assert.rejects(assertCanonicalReady(readyDatabase({ leases: [
    READY_LEASES[0],
    { lease_key: 'robinhood-canonical-head-worker', metadata: { mode: 'canonical_canary' } },
  ] })), (error) => error.code === 'canonical_head_publisher_inactive');
});

test('standalone canonical liquidity process validates and owns its dedicated lease', async () => {
  let definition; let validated = false; let gated = false;
  let started = false; let stopped = false; let closed = false; let quoteOptions;
  const database = { pool: {} };
  const baseRpcClient = {
    providers: ['robinhood-public'],
    request: async () => null,
    requestProvider: async (provider, method) => {
      assert.equal(provider, 'robinhood-public');
      assert.equal(method, 'eth_chainId');
      validated = true;
      return '0x1237';
    },
  };
  const scanner = { scanNextRange: async () => {} };
  const refresher = { runOnce: async () => {} };
  const worker = {
    start: async () => { started = true; },
    stop: async () => { stopped = true; },
    getStatus: () => ({ running: true, scanner: {}, refresher: {} }),
  };
  const runtime = await main({
    options: {
      enabled: true, rpcUrl: 'http://127.0.0.1:8547', rpcTimeoutMs: 5000,
      leaseHeartbeatMs: 30_000, leaseTtlMs: 120_000,
    },
    database, timedDatabase: database, rpcOptions: {},
    rpcClientFactory: () => baseRpcClient, snapshotRepository: {}, cursorRepository: {},
    refreshQueue: {}, source: {},
    rangeRepository: { listHistoricalV4LiquidityRanges: async () => [] },
    metadataReaderFactory: () => ({
      getMetadata: async () => ({}), getBalanceOf: async () => ({}),
    }),
    quoteReaderFactory: (value) => {
      quoteOptions = value;
      return { getSnapshot: async () => ({}) };
    },
    scanner, refresher,
    workerFactory: (deps) => {
      assert.equal(deps.scanner, scanner); assert.equal(deps.refresher, refresher);
      assert.equal(deps.pool, database.pool); return worker;
    },
    leaseManagerFactory: () => ({
      start: (value) => { definition = value; }, stop: async () => {},
    }),
    assertCanonicalReady: async (value) => { assert.equal(value, database); gated = true; },
    close: async () => { closed = true; },
  });
  assert.equal(definition.key, LEASE_KEY);
  assert.deepEqual(definition.metadata, {
    process: 'robinhood-canonical-liquidity', mode: 'canonical_journal',
  });
  assert.deepEqual(definition.metadataProvider(), {
    running: true, scanner: {}, refresher: {},
    rpcGuard: {
      role: 'canonical-liquidity', forbiddenMethod: 'eth_getLogs', forbiddenAttempts: 0,
    },
  });
  assert.equal(quoteOptions.eventFallbackEnabled, false);
  assert.notEqual(quoteOptions.rpcClient, baseRpcClient);
  await definition.start();
  assert.equal(validated, true); assert.equal(gated, true); assert.equal(started, true);
  await runtime.shutdown();
  assert.equal(stopped, true); assert.equal(closed, true);
});

test('standalone canonical liquidity process remains opt-in', async () => {
  await assert.rejects(main({ options: { enabled: false } }), /must be true/);
});
