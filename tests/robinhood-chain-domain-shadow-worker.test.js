'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createRobinhoodChainDomainShadowWorker,
} = require('../src/services/robinhood-chain-domain-shadow-worker');
const { DOMAIN_NOTIFY_CHANNEL } = require('../src/models/robinhood-chain-capture-journal');
const {
  LEASE_KEY, main,
} = require('../src/utils/run-robinhood-chain-domain-shadow-worker');

function result(domain, claimed) {
  return {
    domain, reclaimed: 0, claimed, matched: claimed, canonicalOnly: 0,
    divergent: 0, throughBlock: claimed ? '100' : null,
    completed: claimed, blocked: 0, retried: 0,
  };
}

test('domain shadow worker isolates domains and wakes on canonical notification', async () => {
  const callbacks = []; const cancelled = []; let notification; let listenerStopped = false;
  const schedule = (callback, delay) => {
    const handle = { callback, delay, unref() {} }; callbacks.push(handle); return handle;
  };
  const worker = createRobinhoodChainDomainShadowWorker({
    runners: {
      discovery: { runOnce: async () => result('discovery', 1) },
      market: { runOnce: async () => { throw new Error('market audit failed'); } },
    },
    schedule,
    cancel: (handle) => cancelled.push(handle),
    listenerFactory: (options) => {
      notification = options.onNotification;
      return {
        start: async () => options.onConnected(),
        stop: async () => { listenerStopped = true; },
      };
    },
  }, { batchSize: 10, idlePollMs: 1000 });

  await worker.start();
  assert.equal(callbacks.at(-1).delay, 0);
  const firstTick = callbacks.at(-1); await firstTick.callback();
  await new Promise((resolve) => setImmediate(resolve));
  let status = worker.getStatus();
  assert.equal(status.domains.discovery.totalClaimed, 1);
  assert.match(status.domains.market.lastError, /market audit failed/);
  assert.equal(callbacks.at(-1).delay, 1000);

  notification({ channel: DOMAIN_NOTIFY_CHANNEL });
  assert.equal(cancelled.length, 1);
  assert.equal(callbacks.at(-1).delay, 0);
  status = worker.getStatus();
  assert.equal(status.totalNotifies, 1);
  await worker.stop();
  assert.equal(listenerStopped, true);
});

test('standalone shadow process starts only through its dedicated lease', async () => {
  let definition; let started = false; let stopped = false; let closed = false;
  const worker = {
    start: async () => { started = true; },
    stop: async () => { stopped = true; },
    getStatus: () => ({ mode: 'shadow_compare' }),
  };
  const runtime = await main({
    options: { enabled: true, leaseHeartbeatMs: 30_000, leaseTtlMs: 120_000 },
    workerFactory: () => worker,
    leaseManagerFactory: () => ({
      start: (value) => { definition = value; },
      stop: async () => {},
    }),
    close: async () => { closed = true; },
  });
  assert.equal(definition.key, LEASE_KEY);
  assert.equal(started, false);
  await definition.start();
  assert.equal(started, true);
  await runtime.shutdown();
  assert.equal(stopped, true);
  assert.equal(closed, true);
});
