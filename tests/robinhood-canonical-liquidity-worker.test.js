'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DOMAIN_NOTIFY_CHANNEL } = require('../src/models/robinhood-chain-capture-journal');
const {
  createRobinhoodCanonicalLiquidityWorker,
} = require('../src/services/robinhood-canonical-liquidity-worker');

function scanResult(nextBlock, status = 'scanned') {
  return status === 'caught_up' ? {
    status, nextBlock, safeHead: String(Number(nextBlock) - 1),
    blocks: 0, logs: 0, affected: 0, queued: 0,
  } : {
    status, nextBlock, safeHead: '200', blocks: 10, logs: 3, affected: 2, queued: 2,
  };
}

test('canonical liquidity worker scans fairly and records component telemetry', async () => {
  let scans = 0;
  const worker = createRobinhoodCanonicalLiquidityWorker({
    scanner: { async scanNextRange() { scans += 1; return scanResult(String(100 + scans * 10)); } },
    refresher: { async runOnce() {
      return { status: 'processed', claimed: 4, completed: 3, retried: 1 };
    } },
  }, { maxScanRangesPerTick: 2, refreshBatchSize: 5 });
  const result = await worker.runOnce();
  assert.equal(result.scan.ranges, 2);
  assert.equal(result.scan.blocks, 20);
  assert.equal(result.refresh.claimed, 4);
  const status = worker.getStatus();
  assert.deepEqual({
    ranges: status.scanner.totalRanges, blocks: status.scanner.totalBlocks,
    logs: status.scanner.totalLogs, affected: status.scanner.totalAffected,
    queued: status.scanner.totalQueued,
  }, { ranges: 2, blocks: 20, logs: 6, affected: 4, queued: 4 });
  assert.deepEqual({
    claimed: status.refresher.totalClaimed, completed: status.refresher.totalCompleted,
    retried: status.refresher.totalRetried,
  }, { claimed: 4, completed: 3, retried: 1 });
});

test('canonical liquidity worker isolates scanner failures from refresh work', async () => {
  const worker = createRobinhoodCanonicalLiquidityWorker({
    scanner: { async scanNextRange() {
      throw Object.assign(new Error('journal unavailable'), { code: 'journal_down' });
    } },
    refresher: { async runOnce() {
      return { status: 'idle', claimed: 0, completed: 0, retried: 0 };
    } },
  });
  const result = await worker.runOnce();
  assert.equal(result.scan, null);
  assert.equal(result.refresh.status, 'idle');
  const status = worker.getStatus();
  assert.deepEqual(status.scanner.lastError, {
    code: 'journal_down', message: 'journal unavailable',
  });
  assert.equal(status.totalErrors, 1);
  assert.equal(status.inFlight, false);
});

test('canonical liquidity worker wakes on journal notifications and drains busy work', async () => {
  const callbacks = []; const cancelled = []; let notify; let scans = 0;
  const worker = createRobinhoodCanonicalLiquidityWorker({
    scanner: { async scanNextRange() {
      scans += 1;
      return scans === 1 ? scanResult('110') : scanResult('110', 'caught_up');
    } },
    refresher: { async runOnce() {
      return { status: 'idle', claimed: 0, completed: 0, retried: 0 };
    } },
    schedule: (callback, delay) => {
      const handle = { callback, delay, unref() {} }; callbacks.push(handle); return handle;
    },
    cancel: (handle) => cancelled.push(handle),
    listenerFactory: (options) => {
      notify = options.onNotification;
      return { start: async () => options.onConnected(), stop: async () => {} };
    },
  }, { maxScanRangesPerTick: 1, refreshBatchSize: 100, idlePollMs: 1000 });
  await worker.start();
  assert.equal(callbacks.at(-1).delay, 0);
  await callbacks.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.at(-1).delay, 0);
  await callbacks.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.at(-1).delay, 1000);
  notify({ channel: DOMAIN_NOTIFY_CHANNEL });
  assert.equal(cancelled.length, 1);
  assert.equal(callbacks.at(-1).delay, 0);
  assert.equal(worker.getStatus().totalNotifies, 1);
  await worker.stop();
});

test('canonical liquidity worker validates its dependencies', () => {
  assert.throws(() => createRobinhoodCanonicalLiquidityWorker(), /dependencies/);
});
