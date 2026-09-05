'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DOMAIN_NOTIFY_CHANNEL } = require('../src/models/robinhood-chain-capture-journal');
const {
  createRobinhoodCanonicalHeadWorker,
} = require('../src/services/robinhood-canonical-head-worker');
const {
  LEASE_KEY, assertPublishReady, main,
} = require('../src/utils/run-robinhood-canonical-head-worker');

test('canonical head worker wakes on outbox notification and drains without idle delay', async () => {
  const callbacks = []; const cancelled = []; let notification; let calls = 0;
  const runtime = {
    runOnce: async () => ({
      claimed: calls++ === 0 ? 2 : 0, inserted: 1, duplicates: 1,
      ignored: 0, blocked: 0, retried: 0,
    }),
    snapshot: () => ({
      owner: 'test', tracked: {},
      rpcGuard: { forbiddenMethod: 'eth_getLogs', forbiddenAttempts: 0 },
    }),
  };
  const worker = createRobinhoodCanonicalHeadWorker({
    runtime,
    schedule: (callback, delay) => {
      const handle = { callback, delay, unref() {} }; callbacks.push(handle); return handle;
    },
    cancel: (handle) => cancelled.push(handle),
    listenerFactory: (options) => {
      notification = options.onNotification;
      return { start: async () => options.onConnected(), stop: async () => {} };
    },
  }, { idlePollMs: 100 });

  await worker.start();
  assert.equal(callbacks.at(-1).delay, 0);
  await callbacks.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.at(-1).delay, 0);
  await callbacks.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.at(-1).delay, 100);
  notification({ channel: DOMAIN_NOTIFY_CHANNEL });
  assert.equal(cancelled.length, 1);
  assert.equal(callbacks.at(-1).delay, 0);
  assert.equal(worker.getStatus().totalClaimed, 2);
  await worker.stop();
});

test('canonical head worker fails closed on a forbidden RPC attempt', async () => {
  const callbacks = []; const fatals = [];
  const worker = createRobinhoodCanonicalHeadWorker({
    runtime: {
      runOnce: async () => ({ claimed: 1, blocked: 0 }),
      snapshot: () => ({ rpcGuard: { forbiddenAttempts: 1 } }),
    },
    schedule: (callback, delay) => {
      const handle = { callback, delay, unref() {} }; callbacks.push(handle); return handle;
    },
    listenerFactory: () => ({ start: async () => {}, stop: async () => {} }),
  });
  await worker.start({ onFatal: async (error) => fatals.push(error.code) });
  await callbacks[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fatals, ['live_rpc_method_forbidden']);
  assert.equal(worker.getStatus().halted, true);
  await worker.stop();
});

test('canonical head worker fails closed when a block reaches blocked', async () => {
  const callbacks = []; const fatals = [];
  const worker = createRobinhoodCanonicalHeadWorker({
    runtime: {
      runOnce: async () => ({ claimed: 1, blocked: 1 }),
      snapshot: () => ({ rpcGuard: { forbiddenAttempts: 0 } }),
    },
    schedule: (callback, delay) => {
      const handle = { callback, delay, unref() {} }; callbacks.push(handle); return handle;
    },
    listenerFactory: () => ({ start: async () => {}, stop: async () => {} }),
  });
  await worker.start({ onFatal: async (error) => fatals.push(error.code) });
  await callbacks[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fatals, ['canonical_head_blocked']);
  assert.equal(worker.getStatus().halted, true);
  await worker.stop();
});

test('standalone canonical head process validates RPC and owns a dedicated lease', async () => {
  let definition; let validated = false; let started = false; let closed = false;
  const rpcClient = {};
  const worker = {
    start: async () => { started = true; }, stop: async () => {},
    getStatus: () => ({ running: true, runtime: { rpcGuard: { forbiddenAttempts: 0 } } }),
  };
  const runtime = await main({
    options: {
      enabled: true, publishEnabled: true, rpcUrl: 'http://127.0.0.1:8547',
      leaseHeartbeatMs: 30_000, leaseTtlMs: 120_000,
    },
    rpcClientFactory: () => rpcClient,
    validateChainIds: async (value) => { assert.equal(value, rpcClient); validated = true; },
    assertPublishReady: async () => {},
    workerFactory: ({ rpcClient: value }) => { assert.equal(value, rpcClient); return worker; },
    leaseManagerFactory: () => ({
      start: (value) => { definition = value; }, stop: async () => {}, halt: async () => {},
    }),
    close: async () => { closed = true; },
  });
  assert.equal(definition.key, LEASE_KEY);
  assert.equal(definition.metadata.mode, 'canonical_publish');
  assert.deepEqual(definition.metadataProvider(), {
    running: true, canonicalRuntime: { rpcGuard: { forbiddenAttempts: 0 } },
  });
  await definition.start();
  assert.equal(validated, true); assert.equal(started, true);
  await runtime.shutdown();
  assert.equal(closed, true);
});

test('canonical publisher requires capture and excludes legacy or shadow writers', async () => {
  const database = (rows) => ({ query: async () => ({ rows }) });
  await assert.doesNotReject(assertPublishReady(database([
    { lease_key: 'robinhood-chain-capture-worker' },
  ])));
  await assert.rejects(assertPublishReady(database([])), (error) => (
    error.code === 'canonical_capture_inactive'
  ));
  await assert.rejects(assertPublishReady(database([
    { lease_key: 'robinhood-chain-capture-worker' },
    { lease_key: 'robinhood-head-capture-worker' },
  ])), (error) => error.code === 'canonical_publish_writer_conflict');
  await assert.rejects(assertPublishReady(database([
    { lease_key: 'robinhood-chain-capture-worker' },
    { lease_key: 'robinhood-ingestion-worker' },
  ])), (error) => error.code === 'canonical_publish_writer_conflict');
});

test('standalone canonical head process reports startup failures before retry', async () => {
  let definition; const errors = [];
  const runtime = await main({
    options: {
      enabled: true, rpcUrl: 'http://127.0.0.1:8547',
      leaseHeartbeatMs: 30_000, leaseTtlMs: 120_000,
    },
    rpcClientFactory: () => ({}),
    validateChainIds: async () => { throw new Error('local RPC unavailable'); },
    workerFactory: () => ({ stop: async () => {}, getStatus: () => ({}) }),
    leaseManagerFactory: () => ({
      start: (value) => { definition = value; }, stop: async () => {}, halt: async () => {},
    }),
    logger: { error: (...args) => errors.push(args.join(' ')) },
    close: async () => {},
  });
  await assert.rejects(definition.start(), /local RPC unavailable/);
  assert.match(errors[0], /Startup failed: local RPC unavailable/);
  await runtime.shutdown();
});
