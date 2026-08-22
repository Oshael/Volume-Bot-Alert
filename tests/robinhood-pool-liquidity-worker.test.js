const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodPoolLiquidityWorker,
  runLiquidityTick,
} = require('../src/services/robinhood-pool-liquidity-worker');

const NOW = Date.parse('2026-08-22T12:00:00Z');
const ANCHOR = Object.freeze({
  number: '123', hash: `0x${'a'.repeat(64)}`, observedAt: '2026-08-22T11:59:58Z',
});

function pool(id) {
  return { protocol: 'uniswap-v3', marketKey: `robinhood:uniswap-v3:${id}` };
}

describe('Robinhood independent pool liquidity worker', () => {
  it('uses one anchor per batch and isolates unavailable or failed pools', async () => {
    const pools = [pool('ok'), pool('unavailable'), pool('failed')];
    const anchors = [];
    const snapshots = [];
    const failures = [];
    const result = await runLiquidityTick({
      reader: {
        async readAnchor(tag) { assert.equal(tag, '0x7b'); return ANCHOR; },
        async valuePool(candidate, anchor) {
          anchors.push(anchor);
          if (candidate.marketKey.endsWith('failed')) {
            throw Object.assign(new Error('rpc down'), { code: 'rpc_down' });
          }
          return {
            ...anchor, liquidityUsd: candidate.marketKey.endsWith('unavailable') ? null : '42',
            liquidityRaw: '9', status: candidate.marketKey.endsWith('unavailable')
              ? 'requires_tick_liquidity_distribution' : 'spot_tvl_from_pool_balances',
            confidence: candidate.marketKey.endsWith('unavailable') ? 'none' : 'medium',
          };
        },
      },
      repository: {
        async resolveAnchorBlock() { return '123'; },
        async listDuePools(input) {
          assert.deepEqual(input, {
            dueBefore: '2026-08-22T11:55:00.000Z', limit: 10,
          });
          return pools;
        },
        async recordSnapshot(input) { snapshots.push(input); return true; },
        async recordFailure(input) { failures.push(input); return true; },
      },
    }, { refreshMs: 300_000, batchSize: 10, concurrency: 2 }, () => NOW);

    assert.deepEqual(result, {
      status: 'caught-up', anchorBlock: '123', checked: 3, saved: 1, failed: 2,
    });
    assert.equal(anchors.length, 3);
    assert.equal(anchors.every((anchor) => anchor === ANCHOR), true);
    assert.equal(snapshots[0].checkedAt, '2026-08-22T12:00:00.000Z');
    assert.deepEqual(failures.map((item) => item.error.code).sort(), [
      'liquidity_unavailable', 'rpc_down',
    ]);
  });

  it('coalesces overlapping ticks and exposes cumulative lease telemetry', async () => {
    let release;
    let anchors = 0;
    const worker = createRobinhoodPoolLiquidityWorker({
      now: () => NOW,
      reader: {
        async readAnchor() {
          anchors += 1;
          await new Promise((resolve) => { release = resolve; });
          return ANCHOR;
        },
        async valuePool() { throw new Error('no pools expected'); },
      },
      repository: {
        async resolveAnchorBlock() { return '123'; },
        async listDuePools() { return []; },
        async recordSnapshot() {},
        async recordFailure() {},
      },
    });
    const first = worker.runOnce();
    const second = worker.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.deepEqual(await Promise.all([first, second]), [
      { status: 'caught-up', anchorBlock: '123', checked: 0, saved: 0, failed: 0 },
      { status: 'caught-up', anchorBlock: '123', checked: 0, saved: 0, failed: 0 },
    ]);
    assert.equal(anchors, 1);
    assert.equal(worker.getStatus().totalRuns, 1);
    assert.equal(worker.getStatus().lastCompletedAt, '2026-08-22T12:00:00.000Z');
  });
});
