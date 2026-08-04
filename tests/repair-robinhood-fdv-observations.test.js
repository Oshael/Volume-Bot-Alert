const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  recomputeTransposed,
  __private: { repairV4Transposed },
} = require('../src/utils/repair-robinhood-fdv-observations');

const ONE = 10n ** 18n;

// Fake DB serving one candidate batch then draining, for dry-run pass coverage.
function fakeDb(rows) {
  let served = false;
  return {
    query: async (sql) => {
      if (/COUNT/.test(sql)) return { rows: [{ n: rows.length }] };
      if (served) return { rows: [] };
      served = true;
      return { rows };
    },
  };
}

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

  it('reverses a v4 native-ETH transposition (18d token, 18d ETH quote)', () => {
    // Live v4 bug shape: ETH quote (18d) landed in token_amount_raw, the token (18d)
    // in quote_amount_raw. True swap: 1000 tokens for 0.5 ETH at $2000 -> price 1, vol 1000.
    const fixed = recomputeTransposed({
      side: 'sell',
      token_decimals: 18,
      quote_decimals: 18,
      token_total_supply_raw: (1_000_000_000n * ONE).toString(),
      token_amount_raw: (5n * 10n ** 17n).toString(), // actually 0.5 ETH
      quote_amount_raw: (1_000n * ONE).toString(),     // actually 1000 tokens
      quote_usd_price: '2000',
    });
    assert.equal(fixed.tokenAmountRaw, (1_000n * ONE).toString());
    assert.equal(fixed.quoteAmountRaw, (5n * 10n ** 17n).toString());
    assert.equal(fixed.priceUsd, '1');
    assert.equal(fixed.volumeUsd, '1000');
    assert.equal(fixed.fdvUsd, '1000000000');
    assert.equal(fixed.side, 'buy');
  });
});

describe('repairV4Transposed pass', () => {
  it('counts and would-repair a v4 candidate in dry-run without writing', async () => {
    const row = {
      chain: 'robinhood', transaction_hash: '0xtx', log_index: '1', block_number: '10',
      side: 'sell', token_decimals: 18, quote_decimals: 18,
      token_total_supply_raw: (1_000_000_000n * ONE).toString(),
      token_amount_raw: (5n * 10n ** 17n).toString(),
      quote_amount_raw: (1_000n * ONE).toString(),
      quote_usd_price: '2000',
    };
    const summary = await repairV4Transposed(fakeDb([row]), { mode: 'dry-run', batchSize: 500 });
    assert.equal(summary.candidates, 1);
    assert.equal(summary.wouldRepair, 1);
    assert.equal(summary.repaired, 0);
    assert.equal(summary.sample[0].after.priceUsd, '1');
  });
});
