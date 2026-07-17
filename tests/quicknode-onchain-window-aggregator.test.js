const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const windowAggregator = require('../src/services/quicknode-onchain-window-aggregator');

function candidate(overrides = {}) {
  return {
    tokenMint: 'TokenA111111111111111111111111111111111111',
    program: 'pumpswap',
    signature: 'sig-a',
    estimatedSolVolume: 0.01,
    estimatedUsdVolume: 1.5,
    volumeSource: 'wsol',
    observedAtMs: 1_000_000,
    ...overrides,
  };
}

describe('quicknode onchain window aggregator', () => {
  it('aggregates swaps by token across 1m and 5m windows', () => {
    const reports = windowAggregator.buildWindowReports([
      candidate({ signature: 'sig-a', estimatedSolVolume: 0.01, observedAtMs: 1_000_000 }),
      candidate({ signature: 'sig-b', program: 'raydium-cpmm', estimatedUsdVolume: 2.25, volumeSource: 'usdc', observedAtMs: 999_000 }),
      candidate({ tokenMint: 'TokenB111111111111111111111111111111111111', signature: 'sig-c', estimatedSolVolume: 0.02, observedAtMs: 998_000 }),
    ], {
      nowMs: 1_000_000,
      limit: 10,
    });

    const tokenA1m = reports.find((report) => report.window === '1m' && report.tokenMint.startsWith('TokenA'));
    assert.equal(tokenA1m.swaps, 2);
    assert.equal(tokenA1m.estimatedSolVolume, 0.02);
    assert.equal(tokenA1m.estimatedUsdVolume, 3.75);
    assert.deepEqual(tokenA1m.programs, ['pumpswap', 'raydium-cpmm']);
    assert.deepEqual(tokenA1m.volumeSources, { usdc: 1, wsol: 1 });
    assert.equal(tokenA1m.latestSignature, 'sig-a');

    const tokenB5m = reports.find((report) => report.window === '5m' && report.tokenMint.startsWith('TokenB'));
    assert.equal(tokenB5m.swaps, 1);
  });

  it('deduplicates by signature before building windows', () => {
    const aggregator = windowAggregator.createOnchainWindowAggregator();

    assert.equal(aggregator.add(candidate({ signature: 'same-sig' }), 1_000_000).accepted, true);
    assert.deepEqual(aggregator.add(candidate({ signature: 'same-sig', estimatedSolVolume: 2 }), 1_000_000), {
      accepted: false,
      reason: 'duplicate_signature',
    });

    const reports = aggregator.snapshot(1_000_000);
    const tokenA1m = reports.find((report) => report.window === '1m');
    assert.equal(tokenA1m.swaps, 1);
    assert.equal(tokenA1m.estimatedSolVolume, 0.01);
  });

  it('expires events outside each window', () => {
    const reports = windowAggregator.buildWindowReports([
      candidate({ signature: 'recent', observedAtMs: 1_000_000 }),
      candidate({ signature: 'old-for-1m', observedAtMs: 930_000 }),
      candidate({ signature: 'expired-for-all', observedAtMs: 650_000 }),
    ], {
      nowMs: 1_000_000,
      limit: 10,
    });

    const tokenA1m = reports.find((report) => report.window === '1m');
    const tokenA5m = reports.find((report) => report.window === '5m');

    assert.equal(tokenA1m.swaps, 1);
    assert.equal(tokenA5m.swaps, 2);
  });

  it('ignores invalid candidates', () => {
    const aggregator = windowAggregator.createOnchainWindowAggregator();

    assert.deepEqual(aggregator.add({ tokenMint: 'TokenA111111111111111111111111111111111111' }, 1_000_000), {
      accepted: false,
      reason: 'invalid_candidate',
    });
    assert.equal(aggregator.size(), 0);
  });
});
