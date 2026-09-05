'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalLiquidityRefresher,
} = require('../src/services/robinhood-canonical-liquidity-refresher');

function row(id, attemptCount = 1) {
  return {
    protocol: 'uniswap-v3', market_key: `robinhood:uniswap-v3:${id}`,
    generation: '2', attempt_count: attemptCount,
    pool_address: `0x${'1'.repeat(40)}`, pool_id: null, origin_address: null,
    token_address: `0x${'2'.repeat(40)}`, quote_address: `0x${'3'.repeat(40)}`,
    currency0: `0x${'2'.repeat(40)}`, currency1: `0x${'3'.repeat(40)}`,
    discovered_at: new Date('2026-09-05T00:00:00Z'),
  };
}

function fixture(overrides = {}, input = {}) {
  const calls = [];
  const rows = overrides.rows === undefined ? [row('ok'), row('failed', 3)] : overrides.rows;
  const deps = {
    reader: {},
    snapshotRepository: {
      async resolveCanonicalAnchorWindow() {
        calls.push({ operation: 'resolveCanonicalAnchorWindow' });
        if (overrides.anchorBlock === null) return null;
        return overrides.window || {
          anchorBlock: overrides.anchorBlock || '200', captureBlock: '225', lagBlocks: '25',
        };
      },
    },
    refreshQueue: {
      async reclaimExpired() { calls.push({ operation: 'reclaimExpired' }); return 2; },
      async claim(value) { calls.push({ operation: 'claim', value }); return rows; },
      async complete(value) {
        calls.push({ operation: 'complete', value });
        return { removed: true, requeued: false };
      },
      async retry(value) { calls.push({ operation: 'retry', value }); return true; },
    },
    async valuePools(_deps, pools, anchorBlock, options) {
      calls.push({ operation: 'valuePools', pools, anchorBlock, options });
      if (overrides.valuationError) throw overrides.valuationError;
      return {
        anchorBlock, affected: pools.length, saved: 1, failed: 1, timing: {},
        poolResults: pools.map((pool) => pool.marketKey.endsWith('failed') ? {
          protocol: pool.protocol, marketKey: pool.marketKey, status: 'failed',
          error: { code: 'rpc_timeout', message: 'rpc down' },
        } : { protocol: pool.protocol, marketKey: pool.marketKey, status: 'completed' }),
      };
    },
  };
  return {
    calls,
    refresher: createRobinhoodCanonicalLiquidityRefresher(deps, {
      owner: 'refresh-worker', ...input,
    }),
  };
}

describe('Robinhood canonical liquidity refresher', () => {
  it('values a claimed batch and settles each leased generation', async () => {
    const { calls, refresher } = fixture();
    const result = await refresher.runOnce();
    assert.equal(result.status, 'processed');
    assert.deepEqual({
      anchorBlock: result.anchorBlock, reclaimed: result.reclaimed,
      claimed: result.claimed, completed: result.completed, retried: result.retried,
    }, { anchorBlock: '200', reclaimed: 2, claimed: 2, completed: 1, retried: 1 });
    const claim = calls.find((call) => call.operation === 'claim');
    assert.deepEqual(claim.value, { owner: 'refresh-worker', limit: 100, leaseMs: 600_000 });
    const valuation = calls.find((call) => call.operation === 'valuePools');
    assert.equal(valuation.pools[0].marketKey, 'robinhood:uniswap-v3:ok');
    assert.equal(valuation.anchorBlock, '200');
    assert.equal(valuation.options.includePoolResults, true);
    const completed = calls.find((call) => call.operation === 'complete');
    assert.deepEqual(completed.value, {
      owner: 'refresh-worker', protocol: 'uniswap-v3',
      marketKey: 'robinhood:uniswap-v3:ok', generation: '2',
    });
    const retried = calls.find((call) => call.operation === 'retry');
    assert.equal(retried.value.marketKey, 'robinhood:uniswap-v3:failed');
    assert.equal(retried.value.retryMs, 20_000);
    assert.deepEqual(retried.value.error, { code: 'rpc_timeout', message: 'rpc down' });
  });

  it('does not claim work until the processing frontier is available', async () => {
    const { calls, refresher } = fixture({ anchorBlock: null });
    assert.deepEqual(await refresher.runOnce(), {
      status: 'frontier_unavailable', reclaimed: 2, claimed: 0, completed: 0, retried: 0,
    });
    assert.equal(calls.some((call) => call.operation === 'claim'), false);
  });

  it('does not claim pools outside the pruned state window', async () => {
    const { calls, refresher } = fixture({ window: {
      anchorBlock: '100', captureBlock: '50100', lagBlocks: '50000',
    } });
    assert.deepEqual(await refresher.runOnce(), {
      status: 'frontier_lagging', anchorBlock: '100', captureBlock: '50100',
      lagBlocks: '50000', maxAnchorLagBlocks: 128,
      reclaimed: 2, claimed: 0, completed: 0, retried: 0,
    });
    assert.equal(calls.some((call) => call.operation === 'claim'), false);
  });

  it('returns idle without reading the node when no pool is due', async () => {
    const { calls, refresher } = fixture({ rows: [] });
    assert.deepEqual(await refresher.runOnce(), {
      status: 'idle', anchorBlock: '200', reclaimed: 2,
      claimed: 0, completed: 0, retried: 0,
    });
    assert.equal(calls.some((call) => call.operation === 'valuePools'), false);
  });

  it('reschedules the whole lease batch after a shared valuation failure', async () => {
    const error = Object.assign(new Error('database unavailable'), { code: 'db_down' });
    const { calls, refresher } = fixture({ valuationError: error });
    await assert.rejects(refresher.runOnce(), (received) => received === error);
    const retries = calls.filter((call) => call.operation === 'retry');
    assert.equal(retries.length, 2);
    assert.equal(retries[0].value.retryMs, 5_000);
    assert.equal(retries[1].value.retryMs, 20_000);
    assert.equal(retries.every((call) => call.value.error === error), true);
  });

  it('rejects incomplete dependencies and unsafe bounds', () => {
    assert.throws(() => createRobinhoodCanonicalLiquidityRefresher(), /dependencies/);
    assert.throws(() => fixture({}, { limit: 501 }), /between 1 and 500/);
    assert.throws(() => fixture({}, { retryBaseMs: 10, retryMaxMs: 5 }), /retryMaxMs/);
  });
});
