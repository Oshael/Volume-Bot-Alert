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
        async recordSnapshots(rows) { snapshots.push(...rows); return rows.length; },
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

  it('keeps the range cursor after a failed batch and retries the same range', async () => {
    const commits = [];
    const batches = [];
    let fail = true;
    const worker = await createRobinhoodPoolLiquidityWorker({
      rpcClient: { async request(method) {
        if (method === 'eth_blockNumber') return '0x70';
        if (method === 'eth_getLogs') return [{
          blockHash: HASH, transactionHash: `0x${'b'.repeat(64)}`, logIndex: '0x0', blockNumber: '0x69',
        }];
        if (method === 'eth_getBlockByNumber') return { hash: HASH, timestamp: '0x1' };
        assert.fail(`unexpected RPC ${method}`);
      } },
      reader: {
        async readAnchor() { return { number: '110', hash: HASH, observedAt: '2026-08-22T12:00:00Z' }; },
        async valuePool(_pool, anchor) { return { ...anchor, liquidityUsd: '42', liquidityRaw: '9' }; },
      },
      snapshotRepository: {
        async listPoolsForLiquidityEvents() {
          return Array.from({ length: 51 }, (_, index) => ({ protocol: 'uniswap-v3', marketKey: `pool-${index}` }));
        },
        async recordSnapshots(rows) {
          batches.push(rows.length);
          if (fail && rows.length === 1) throw Object.assign(new Error('disconnected'), { code: 'ECONNRESET' });
          return rows.length;
        },
        async recordFailure() { assert.fail('database failure must not become a pool failure'); },
      },
      cursorRepository: {
        async loadCursor() { return CURSOR; },
        async resolveProcessingFrontier() { return '110'; },
        async commitRange(input) { commits.push(input); return { ...CURSOR, nextBlock: input.nextBlock }; },
      },
    }, { rangeSize: 6, maxRangesPerPoll: 1 });
    await assert.rejects(worker.pollOnce(), /disconnected/);
    assert.deepEqual(commits, []);
    assert.equal(worker.getStatus().nextBlock, '105');
    fail = false;
    await worker.pollOnce();
    assert.deepEqual(batches, [50, 1, 50, 1]);
    assert.equal(commits[0].fromBlock, '105');
    assert.equal(worker.getStatus().nextBlock, '111');
    assert.equal(worker.getStatus().valuation.saved, 51);
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
