const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  BUNDLE_RULE_VERSION,
  planBundleFundingScan,
} = require('../src/services/robinhood-bundle-funding-scan-plan');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;
const WALLET_A = `0x${'a'.repeat(40)}`;
const WALLET_B = `0x${'b'.repeat(40)}`;
const WALLET_C = `0x${'c'.repeat(40)}`;

function candidate(overrides = {}) {
  return {
    tokenAddress: TOKEN_A,
    walletAddress: WALLET_A,
    launchBlock: '100',
    firstBuyBlock: '100',
    firstBuyTransactionIndex: '1',
    ...overrides,
  };
}

function plan(candidates, overrides = {}) {
  return planBundleFundingScan({
    sourceFromBlock: '1', sourceThroughBlock: '1000', lookbackBlocks: '10',
    candidates, ...overrides,
  });
}

describe('Robinhood bundle funding scan plan', () => {
  it('keeps launch through launch + 3 inclusive and requires two wallets per token', () => {
    const result = plan([
      candidate(),
      candidate({ walletAddress: WALLET_B, firstBuyBlock: '103' }),
      candidate({ walletAddress: WALLET_C, firstBuyBlock: '104' }),
      candidate({ tokenAddress: TOKEN_B, walletAddress: WALLET_C }),
    ]);

    assert.equal(result.ruleVersion, BUNDLE_RULE_VERSION);
    assert.equal(result.maxLaunchDeltaBlocks, '3');
    assert.equal(result.candidateTokens, 1);
    assert.equal(result.candidateWallets, 2);
    assert.deepEqual(result.candidates.map(({ walletAddress }) => walletAddress), [
      WALLET_A, WALLET_B,
    ]);
  });

  it('unifies overlapping pre-buy windows and includes the first-buy block', () => {
    const result = plan([
      candidate(),
      candidate({ walletAddress: WALLET_B, firstBuyBlock: '103' }),
    ]);

    assert.equal(result.candidateRanges, 2);
    assert.equal(result.mergedRanges, 1);
    assert.deepEqual(result.ranges, [{ fromBlock: '90', toBlock: '103' }]);
    assert.equal(result.blocksToScan, '14');
    assert.equal(result.sourceBlocks, '1000');
    assert.equal(result.sourceCoverageBps, 140);
  });

  it('clamps lookback to the archive frontier and merges adjacent ranges', () => {
    const result = plan([
      candidate({ firstBuyBlock: '100' }),
      candidate({ walletAddress: WALLET_B, firstBuyBlock: '103' }),
      candidate({ tokenAddress: TOKEN_B, walletAddress: WALLET_A,
        launchBlock: '111', firstBuyBlock: '111' }),
      candidate({ tokenAddress: TOKEN_B, walletAddress: WALLET_C,
        launchBlock: '111', firstBuyBlock: '111', firstBuyTransactionIndex: '2' }),
    ], { sourceFromBlock: '95', lookbackBlocks: '7' });

    assert.deepEqual(result.ranges, [{ fromBlock: '95', toBlock: '111' }]);
  });

  it('deduplicates identical evidence and fails closed on conflicting first buys', () => {
    const repeated = candidate();
    assert.equal(plan([repeated, repeated, candidate({ walletAddress: WALLET_B })])
      .candidateWallets, 2);
    assert.throws(() => plan([
      repeated,
      candidate({ firstBuyBlock: '101', firstBuyTransactionIndex: '2' }),
      candidate({ walletAddress: WALLET_B }),
    ]), /first-buy evidence conflicts/);
  });

  it('returns an empty bounded workload when no token has a candidate pair', () => {
    const result = plan([candidate()]);

    assert.equal(result.candidateTokens, 0);
    assert.equal(result.candidateWallets, 0);
    assert.equal(result.blocksToScan, '0');
    assert.deepEqual(result.ranges, []);
  });

  it('rejects incoherent positions and source bounds', () => {
    assert.throws(() => plan([
      candidate({ firstBuyBlock: '99' }), candidate({ walletAddress: WALLET_B }),
    ]), /precedes launchBlock/);
    assert.throws(() => plan([
      candidate({ launchBlock: '1000', firstBuyBlock: '1000' }),
      candidate({ walletAddress: WALLET_B, launchBlock: '1000', firstBuyBlock: '1001' }),
    ]), /exceeds source frontier/);
    assert.throws(() => plan([
      candidate(), candidate({ walletAddress: WALLET_B }),
    ], { sourceFromBlock: '101' }), /precedes source frontier/);
    assert.throws(() => plan([], {
      sourceFromBlock: '100', sourceThroughBlock: '99',
    }), /precedes sourceFromBlock/);
  });
});
