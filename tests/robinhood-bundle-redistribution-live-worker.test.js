const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBundleRedistributionLiveWorker, processTask,
  __private: { buildRuntime },
} = require('../src/services/robinhood-bundle-redistribution-live-worker');

const TOKEN = `0x${'9'.repeat(40)}`;
const SOURCE = `0x${'1'.repeat(40)}`;
const CREATOR = `0x${'2'.repeat(40)}`;
const A = `0x${'3'.repeat(40)}`;
const B = `0x${'4'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function recipient(walletAddress, minute) {
  return { walletAddress, transfer: { blockNumber: '20', transactionIndex: '1',
    logIndex: '2', transactionHash: HASH, blockTime: '2026-09-01T12:01:00Z',
    amountRaw: '100' }, firstSell: { blockNumber: '21', transactionIndex: '2',
    actionIndex: String(minute), transactionHash: HASH,
    blockTime: `2026-09-01T12:0${minute}:00Z`, fdvUsd: null } };
}

function evidence() {
  return { ready: true, creatorAddress: CREATOR, barrierAddresses: [],
    frontier: { blockNumber: '100', blockHash: HASH }, sources: [{
      tokenAddress: TOKEN, sourceWallet: SOURCE,
      sourceBuy: { blockNumber: '10', transactionIndex: '0', actionIndex: '1',
        transactionHash: HASH, blockTime: '2026-09-01T12:00:00Z', fdvUsd: 50_000 },
      recipients: [recipient(A, 2), recipient(B, 3)],
    }] };
}

describe('Robinhood BUNDLED redistribution LIVE worker', () => {
  it('classifies PostgreSQL evidence and atomically completes its queue version', async () => {
    let loadInput; let stored;
    const task = { tokenAddress: TOKEN, observationFromBlock: '50',
      requestedVersion: '2', owner: 'worker' };
    const result = await processTask({
      source: { async loadToken(tokenAddress, input) {
        loadInput = { tokenAddress, input }; return evidence();
      } },
      queue: { async replaceSnapshotAndComplete(input) {
        stored = input; return { completed: true, snapshot: { status: 'published' } };
      } },
    }, task);
    assert.deepEqual(loadInput, { tokenAddress: TOKEN,
      input: { observationFromBlock: '50' } });
    assert.equal(stored.snapshot.state.sourceKind, 'live');
    assert.equal(stored.snapshot.state.sourceVersion, '2');
    assert.equal(stored.snapshot.groups.length, 1);
    assert.deepEqual(result, { status: 'materialized', tokenAddress: TOKEN,
      sources: 1, groups: 1, members: 3 });
  });

  it('defers incomplete durable frontiers instead of publishing a negative', async () => {
    await assert.rejects(processTask({
      source: { async loadToken() { return { ready: false,
        reason: 'transfer_frontier_behind' }; } },
      queue: { async replaceSnapshotAndComplete() { throw new Error('unexpected write'); } },
    }, { tokenAddress: TOKEN, observationFromBlock: '50', requestedVersion: '1' }),
    (error) => error.code === 'redistribution_source_not_ready'
      && error.reason === 'transfer_frontier_behind');
  });

  it('bounds concurrent claims and retries every independently deferred token', async () => {
    const tasks = [1, 2, 3].map((attemptCount) => ({ tokenAddress: TOKEN,
      observationFromBlock: '50', requestedVersion: String(attemptCount), attemptCount }));
    let active = 0; let maximum = 0; const retries = [];
    const runtime = {
      queue: { async claimBatch() { return tasks; }, async retry(input) { retries.push(input); } },
      source: { async loadToken() {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve)); active -= 1;
        return { ready: false, reason: 'holder_frontier_unavailable' };
      } },
    };
    const worker = createRobinhoodBundleRedistributionLiveWorker({ runtime, owner: 'worker' });
    const result = await worker.runOnce();
    assert.deepEqual(result, { status: 'partial', claimed: 3, materialized: 0, deferred: 3 });
    assert.equal(maximum, 2);
    assert.equal(retries.length, 3);
    assert.equal(worker.getStatus().totalDeferred, 3);
  });

  it('builds a PostgreSQL-only runtime', () => {
    const calls = [];
    const runtime = buildRuntime({ database: {},
      queueFactory(input) { calls.push(['queue', input]); return {}; },
      sourceFactory(input) { calls.push(['source', input]); return {}; },
    }, { statementTimeoutMs: 12_000 });
    assert.deepEqual(Object.keys(runtime).sort(), ['queue', 'source']);
    assert.equal(calls[1][1].statementTimeoutMs, 12_000);
  });
});
