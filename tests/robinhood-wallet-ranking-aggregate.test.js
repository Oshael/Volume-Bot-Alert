const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { rankOpenWalletPositions } = require('../src/services/robinhood-wallet-ranking-aggregate');

const AS_OF = '2026-09-27T12:00:00.000Z';
const OLD = '2026-08-01T12:00:00.000Z';
const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;
const D = `0x${'d'.repeat(40)}`;
const TOKEN_ONE = `0x${'1'.repeat(40)}`;
const TOKEN_TWO = `0x${'2'.repeat(40)}`;

function position(walletAddress, tokenAddress, overrides = {}) {
  return {
    walletAddress, tokenAddress, tokenDecimals: 0,
    currentPriceUsd: '3', windowStartPriceUsd: '2', historyComplete: true,
    events: [{ type: 'buy', time: OLD, amountRaw: '10', volumeUsd: '10' }],
    ...overrides,
  };
}

function rank(positions, overrides = {}) {
  return rankOpenWalletPositions({
    positions, window: '24h', asOf: AS_OF, universeComplete: true, ...overrides,
  });
}

describe('Robinhood Top Wallets aggregation', () => {
  it('sums open positions per wallet and uses wallet address to break gain ties', () => {
    const result = rank([
      position(B, TOKEN_ONE),
      position(A, TOKEN_ONE),
      position(A, TOKEN_TWO),
      position(C, TOKEN_ONE, { currentPriceUsd: '1' }),
      position(D, TOKEN_ONE, { events: [
        { type: 'buy', time: OLD, amountRaw: '10', volumeUsd: '10' },
        { type: 'sell', time: AS_OF, amountRaw: '10' },
      ] }),
    ]);
    assert.deepEqual(result.ranked.map(({ walletAddress, gainUsd, openPositionCount }) => (
      [walletAddress, gainUsd, openPositionCount]
    )), [[A, '20', 2], [B, '10', 1], [C, '-10', 1]]);
    assert.deepEqual(result.ranked.map(({ rank: place }) => place), [1, 2, 3]);
    assert.equal(result.coverage, 'complete');
    assert.equal(result.rankingIsComplete, true);
    assert.equal(result.candidateWalletCount, 4);
    assert.equal(result.windowStart, '2026-09-26T12:00:00.000Z');

    const tied = rank([position(B, TOKEN_ONE), position(A, TOKEN_ONE)], { limit: 1 });
    assert.deepEqual(tied.ranked.map(({ walletAddress }) => walletAddress), [A]);
  });

  it('excludes wallets with any partial open position and labels the ranking partial', () => {
    const result = rank([
      position(A, TOKEN_ONE),
      position(A, TOKEN_TWO, { windowStartPriceUsd: null }),
      position(B, TOKEN_ONE),
    ]);
    assert.deepEqual(result.ranked.map(({ walletAddress }) => walletAddress), [B]);
    assert.equal(result.excludedWalletCount, 1);
    assert.equal(result.coverage, 'partial');
    assert.equal(result.rankingIsComplete, false);
    assert.deepEqual(result.reasons, ['basis_unavailable']);
  });

  it('never presents a batch as a global ranking without complete candidates', () => {
    const result = rank([position(A, TOKEN_ONE)], { universeComplete: false });
    assert.deepEqual(result.ranked, []);
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.reasons, ['candidate_universe_incomplete']);
  });

  it('uses purchase cost for ALL and ignores a window price in that mode', () => {
    const result = rank([position(A, TOKEN_ONE, { windowStartPriceUsd: null })], {
      window: 'ALL',
    });
    assert.equal(result.windowStart, null);
    assert.equal(result.ranked[0].gainUsd, '20');
    assert.equal(result.coverage, 'complete');
  });

  it('orders tiny USD gains without converting them to floating point numbers', () => {
    const result = rank([
      position(B, TOKEN_ONE, { currentPriceUsd: `2.${'0'.repeat(35)}1` }),
      position(A, TOKEN_ONE, { currentPriceUsd: `2.${'0'.repeat(35)}2` }),
    ]);
    assert.deepEqual(result.ranked.map(({ walletAddress }) => walletAddress), [A, B]);
  });

  it('ranks an old bag from a current snapshot when window evidence is complete', () => {
    const result = rank([position(A, TOKEN_ONE, {
      quantityRaw: '10', costBasisUsd: '10', quality: 'exact_swap_only',
      projectionAligned: true, eventsComplete: true, events: [],
    })], { positionSource: 'snapshot' });
    assert.equal(result.ranked[0].gainUsd, '10');
    const partial = rank([position(A, TOKEN_ONE, {
      quantityRaw: '10', costBasisUsd: '10', quality: 'exact_swap_only',
      projectionAligned: true, eventsComplete: false, events: [],
    })], { positionSource: 'snapshot' });
    assert.equal(partial.ranked.length, 0);
    assert.equal(partial.coverage, 'partial');
  });

  it('rejects duplicate pairs and invalid ranking limits', () => {
    assert.throws(() => rank([
      position(A, TOKEN_ONE), position(`0x${'A'.repeat(40)}`, TOKEN_ONE),
    ]), /duplicate wallet\/token/);
    assert.throws(() => rank([], { limit: 101 }), /limit must be between/);
  });
});
