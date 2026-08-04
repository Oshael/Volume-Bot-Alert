const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { recomputeTransposed } = require('../src/utils/repair-robinhood-fdv-observations');

const ONE = 10n ** 18n;

// A transposed row stores the token's amount in quote_amount_raw and vice versa;
// decimals/supply/quote price are untouched. Here the true swap is 2 tokens (18d)
// for 5 USDG (6d) at $1, supply 1e9 tokens -> price 2.5, fdv 2.5e9.
function transposedRow(overrides = {}) {
  return {
    side: 'sell',
    token_decimals: 18,
    quote_decimals: 6,
    token_total_supply_raw: (1_000_000_000n * ONE).toString(),
    token_amount_raw: (5n * 10n ** 6n).toString(),   // actually the quote (USDG) amount
    quote_amount_raw: (2n * ONE).toString(),          // actually the token amount
    quote_usd_price: '1',
    ...overrides,
  };
}

describe('recomputeTransposed', () => {
  it('swaps the amounts back and revalues price, volume, fdv and side', () => {
    const fixed = recomputeTransposed(transposedRow());
    assert.equal(fixed.tokenAmountRaw, (2n * ONE).toString());
    assert.equal(fixed.quoteAmountRaw, (5n * 10n ** 6n).toString());
    assert.equal(fixed.tokenAmount, '2');
    assert.equal(fixed.quoteAmount, '5');
    assert.equal(fixed.priceQuote, '2.5');
    assert.equal(fixed.priceUsd, '2.5');
    assert.equal(fixed.volumeUsd, '5');
    assert.equal(fixed.fdvUsd, '2500000000');
    assert.equal(fixed.side, 'buy'); // flipped from sell
  });

  it('refuses to touch a row the swap does not make sane (guards against mis-identification)', () => {
    // Swapping yields a 1e-18-token / 1e12-quote trade -> price ~1e30, fdv still absurd.
    const row = transposedRow({
      token_decimals: 18,
      quote_decimals: 18,
      token_amount_raw: (10n ** 30n).toString(),
      quote_amount_raw: '1',
    });
    assert.deepEqual(recomputeTransposed(row), { skip: 'still_absurd' });
  });
});
