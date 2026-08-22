const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { LIQUIDITY_EVENT_TOPICS } = require('../src/services/robinhood-pool-liquidity-events');
const {
  createRobinhoodPoolLiquidityWorker,
} = require('../src/services/robinhood-pool-liquidity-worker');

const HASH = `0x${'a'.repeat(64)}`;
const CURSOR = Object.freeze({
  coverageStartBlock: '100', nextBlock: '105', safeHead: '104',
  checkpoint: { number: '104', hash: HASH, timestampMs: 1 }, version: 1,
});

function pollerStub(captured) {
  return (options) => {
    Object.assign(captured, options);
    return { pollOnce() {}, start() {}, stop() {}, getStatus: () => ({ nextBlock: '105' }) };
  };
}

describe('Robinhood event-driven pool liquidity worker', () => {
  it('caps ranges at processing and commits only after valuing affected pools', async () => {
    const captured = {};
    const commits = [];
    const snapshots = [];
    const worker = await createRobinhoodPoolLiquidityWorker({
      rpcClient: { async request(method) {
        assert.equal(method, 'eth_blockNumber'); return '0x78';
      } },
      reader: {
        async readAnchor() { return { number: '110', hash: HASH, observedAt: '2026-08-22T12:00:00Z' }; },
        async valuePool(_pool, anchor) {
          return { ...anchor, liquidityUsd: '42', liquidityRaw: '9', status: 'ready', confidence: 'high' };
        },
      },
      snapshotRepository: {
        async listPoolsForLiquidityEvents() { return [{ protocol: 'uniswap-v3', marketKey: 'pool' }]; },
        async recordSnapshot(input) { snapshots.push(input); return true; },
        async recordFailure() {},
      },
      cursorRepository: {
        async loadCursor() { return CURSOR; },
        async resolveProcessingFrontier() { return '110'; },
        async commitRange(input) { commits.push(input); return { ...CURSOR, nextBlock: input.nextBlock }; },
      },
      pollerFactory: pollerStub(captured),
    }, { confirmations: 2 });
    assert.deepEqual(captured.filter, { topics: [LIQUIDITY_EVENT_TOPICS] });
    assert.equal(await captured.client.request('eth_blockNumber', []), '0x70');
    const result = await captured.onLogs([{ address: `0x${'1'.repeat(40)}` }], { toBlock: '110' });
    await captured.onRange({ fromBlock: '105', nextBlock: '111', safeHead: '110',
      checkpoint: { number: '110', hash: HASH }, consumerResult: result });
    assert.equal(snapshots.length, 1);
    assert.equal(commits[0].nextBlock, '111');
    assert.equal(worker.getStatus().valuation.saved, 1);
    await captured.onRemoved([], { reason: 'checkpoint_hash_changed' });
    await assert.rejects(captured.onRemoved([], { reason: 'rpc_removed_flag' }), (error) => (
      error.code === 'persistent_reorg'
    ));
  });

  it('requires an explicit first start and rejects a reorg below it', async () => {
    const dependencies = {
      rpcClient: { async request() { return '0x64'; } }, reader: {}, snapshotRepository: {},
      cursorRepository: { async loadCursor() { return null; } },
      pollerFactory: pollerStub({}),
    };
    await assert.rejects(createRobinhoodPoolLiquidityWorker(dependencies), (error) => (
      error.code === 'bootstrap_start_required'
    ));
    dependencies.cursorRepository = {
      async loadCursor() { return CURSOR; }, async resolveProcessingFrontier() { return '110'; },
    };
    const captured = {};
    dependencies.pollerFactory = pollerStub(captured);
    await createRobinhoodPoolLiquidityWorker(dependencies);
    await assert.rejects(captured.onReorg({ rewindBlock: '99' }), (error) => (
      error.code === 'persistent_reorg'
    ));
  });
});
