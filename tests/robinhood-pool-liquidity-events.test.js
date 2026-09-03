const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const v2 = require('../src/services/uniswap-v2-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');
const {
  LIQUIDITY_EVENT_TOPICS,
  V3_LIQUIDITY_TOPICS,
  V4_DONATE_TOPIC,
  processLiquidityEventRange,
  repairLiquiditySnapshotsAfterReorg,
} = require('../src/services/robinhood-pool-liquidity-events');

const NOW = Date.parse('2026-08-22T12:00:00Z');
const ANCHOR = Object.freeze({
  number: '110', hash: `0x${'a'.repeat(64)}`, observedAt: '2026-08-22T11:59:58Z',
});

function pool(id) {
  return { protocol: 'uniswap-v3', marketKey: `robinhood:uniswap-v3:${id}` };
}

function coreResult(result) {
  const { timing, ...core } = result;
  assert.equal(typeof timing.totalMs, 'number');
  return core;
}

describe('Robinhood event-driven pool liquidity core', () => {
  it('tracks only events that can change pool state or balances', () => {
    assert.deepEqual(LIQUIDITY_EVENT_TOPICS, [
      v2.TOPICS.sync,
      V3_LIQUIDITY_TOPICS.mint,
      V3_LIQUIDITY_TOPICS.burn,
      V3_LIQUIDITY_TOPICS.collect,
      v3.TOPICS.swap,
      V3_LIQUIDITY_TOPICS.flash,
      v4.TOPICS.modifyLiquidity,
      v4.TOPICS.swap,
      V4_DONATE_TOPIC,
    ]);
    assert.equal(LIQUIDITY_EVENT_TOPICS.includes(v2.TOPICS.swap), false);
    assert.equal(new Set(LIQUIDITY_EVENT_TOPICS).size, LIQUIDITY_EVENT_TOPICS.length);
  });

  it('deduplicates through the repository and values all affected pools at range end', async () => {
    const snapshots = [];
    const failures = [];
    const anchors = [];
    const repository = {
      async listPoolsForLiquidityEvents(logs) {
        assert.equal(logs.length, 3);
        return [pool('ok'), pool('failed')];
      },
      async recordSnapshots(rows) { snapshots.push(...rows); return rows.length; },
      async recordFailure(input) { failures.push(input); },
    };
    const result = await processLiquidityEventRange({
      repository,
      reader: {
        async readAnchor(tag) {
          anchors.push(tag);
          return ANCHOR;
        },
        async valuePool(candidate) {
          if (candidate.marketKey.endsWith('failed')) {
            throw Object.assign(new Error('rpc down'), { code: 'rpc_down' });
          }
          return {
            ...ANCHOR, liquidityUsd: '42', liquidityRaw: '9',
            status: 'spot_tvl_from_pool_balances', confidence: 'medium',
          };
        },
      },
    }, { logs: [{}, {}, {}], toBlock: '110' }, { concurrency: 2, now: () => NOW });
    assert.deepEqual(coreResult(result), { anchorBlock: '110', affected: 2, saved: 1, failed: 1 });
    assert.deepEqual({
      logs: result.timing.logs,
      pools: result.timing.pools,
      chunks: result.timing.chunks,
      snapshots: result.timing.snapshots,
      failures: result.timing.failures,
    }, { logs: 3, pools: 2, chunks: 1, snapshots: 1, failures: 1 });
    assert.deepEqual(anchors, ['0x6e']);
    assert.equal(snapshots[0].checkedAt, '2026-08-22T12:00:00.000Z');
    assert.equal(failures[0].error.code, 'rpc_down');
  });

  it('clears orphaned snapshots and rebuilds every affected pool before the rewind', async () => {
    const anchors = [];
    const repository = {
      async invalidateSnapshotsFromBlock(input) {
        assert.deepEqual(input, { rewindBlock: '100' });
        return [pool('orphaned')];
      },
      async recordSnapshots(rows) { return rows.length; },
      async recordFailure() {},
    };
    const result = await repairLiquiditySnapshotsAfterReorg({
      repository,
      reader: {
        async readAnchor(tag) { anchors.push(tag); return { ...ANCHOR, number: '99' }; },
        async valuePool(_pool, anchor) {
          return {
            ...anchor, liquidityUsd: '10', liquidityRaw: '2',
            status: 'spot_tvl_from_pool_balances', confidence: 'medium',
          };
        },
      },
    }, { rewindBlock: '100' }, { now: () => NOW });
    assert.deepEqual(anchors, ['0x63']);
    assert.deepEqual(coreResult(result), { anchorBlock: '99', affected: 1, saved: 1, failed: 0 });
    assert.equal(result.timing.pools, 1);
  });

  it('does not read an anchor when a range has no tracked pools', async () => {
    const result = await processLiquidityEventRange({
      repository: { async listPoolsForLiquidityEvents() { return []; } },
      reader: { async readAnchor() { throw new Error('unexpected anchor read'); } },
    }, { logs: [], toBlock: '123' });
    assert.deepEqual(coreResult(result), { anchorBlock: '123', affected: 0, saved: 0, failed: 0 });
    assert.equal(result.timing.anchorMs, 0);
    assert.equal(result.timing.pools, 0);
  });

  it('persists bounded batches instead of issuing a write for every pool', async () => {
    const batches = [];
    const prepared = [];
    let preparedBeforeFirstValuation = null;
    let inFlight = 0;
    let peakInFlight = 0;
    const candidates = Array.from({ length: 203 }, (_, index) => pool(String(index)));
    const result = await processLiquidityEventRange({
      repository: {
        async listPoolsForLiquidityEvents() { return candidates; },
        async recordSnapshots(rows) { batches.push(rows); return rows.length; },
        async recordSnapshot() { assert.fail('unexpected individual write'); },
        async recordFailure() { assert.fail('unexpected failure'); },
      },
      reader: {
        async readAnchor() { return ANCHOR; },
        async forPoolsAtAnchor(pools, anchor) {
          assert.equal(anchor, ANCHOR);
          prepared.push(pools);
          return this;
        },
        async valuePool() {
          if (preparedBeforeFirstValuation == null) preparedBeforeFirstValuation = prepared.length;
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return { ...ANCHOR, liquidityUsd: '42', liquidityRaw: '9',
            status: 'spot_tvl_from_pool_balances', confidence: 'medium' };
        },
      },
    }, { logs: [{}], toBlock: '110' }, { concurrency: 20 });
    assert.deepEqual(batches.map((rows) => rows.length), [100, 100, 3]);
    assert.deepEqual(prepared.map((pools) => pools.length), [100, 100, 3]);
    assert.equal(peakInFlight, 20);
    assert.equal(preparedBeforeFirstValuation, 2);
    assert.deepEqual(batches.flat().map((row) => row.marketKey), candidates.map((row) => row.marketKey));
    assert.deepEqual(coreResult(result), { anchorBlock: '110', affected: 203, saved: 203, failed: 0 });
    assert.equal(result.timing.chunks, 3);
    assert.equal(result.timing.snapshots, 203);
  });

  it('isolates bad snapshot data but propagates database failures without a write storm', async () => {
    for (const code of ['liquidity_snapshot_invalid', '23514', '40P01', 'ECONNRESET']) {
      const error = Object.assign(new Error('write failed'), { code });
      const individual = [];
      const failures = [];
      const dataError = ['liquidity_snapshot_invalid', '23514'].includes(code);
      const task = processLiquidityEventRange({
        repository: {
          async listPoolsForLiquidityEvents() { return [pool('ok'), pool('bad')]; },
          async recordSnapshots() { throw error; },
          async recordSnapshot(row) {
            individual.push(row.marketKey);
            if (row.marketKey.endsWith('bad')) throw error;
            return true;
          },
          async recordFailure(row) { failures.push(row); },
        },
        reader: {
          async readAnchor() { return ANCHOR; },
          async valuePool() { return { ...ANCHOR, liquidityUsd: '42', liquidityRaw: '9' }; },
        },
      }, { logs: [{}], toBlock: '110' });
      if (dataError) {
        assert.deepEqual(coreResult(await task), { anchorBlock: '110', affected: 2, saved: 1, failed: 1 });
        assert.equal(individual.length, 2);
        assert.equal(failures[0].marketKey, pool('bad').marketKey);
      } else {
        await assert.rejects(task, (received) => received === error);
        assert.deepEqual(individual, []);
        assert.deepEqual(failures, []);
      }
    }
  });
});
