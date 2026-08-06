const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRepair,
  recomputeSpot,
  recomputeTransposed,
  __private: { parseArgs, repairSpot, repairTransposed, repairUncapped, repairV4Transposed },
} = require('../src/utils/repair-robinhood-fdv-observations');

const ONE = 10n ** 18n;
const Q96 = 1n << 96n;

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

function concentratedSwapData(protocol, sqrtPriceX96 = Q96) {
  const word = (value) => BigInt(value).toString(16).padStart(64, '0');
  const values = protocol === 'uniswap-v3'
    ? [1, 2, sqrtPriceX96, 3, 4]
    : [1, 2, sqrtPriceX96, 3, 4, 5];
  return `0x${values.map(word).join('')}`;
}

function spotRow(protocol, overrides = {}) {
  return {
    protocol,
    token_address: '0x2222222222222222222222222222222222222222',
    quote_address: '0x3333333333333333333333333333333333333333',
    quote_index: protocol === 'uniswap-v4' ? '1' : null,
    token_decimals: 18,
    quote_decimals: 18,
    token_total_supply_raw: (1_000_000n * ONE).toString(),
    quote_usd_price: '2',
    log_data: concentratedSwapData(protocol),
    ...overrides,
  };
}

describe('concentrated-liquidity spot repair', () => {
  it('recomputes V3/V4 price and FDV from sqrtPriceX96 without changing volume fields', () => {
    for (const protocol of ['uniswap-v3', 'uniswap-v4']) {
      const fixed = recomputeSpot(spotRow(protocol));
      assert.deepEqual(fixed, {
        priceQuote: '1',
        priceUsd: '2',
        fdvUsd: '2000000',
      });
    }
  });

  it('inverts the V4 sqrt ratio when the frozen quote is currency0', () => {
    const fixed = recomputeSpot(spotRow('uniswap-v4', {
      quote_index: '0',
      log_data: concentratedSwapData('uniswap-v4', 2n * Q96),
    }));
    assert.equal(fixed.priceQuote, '0.25');
    assert.equal(fixed.priceUsd, '0.5');
    assert.equal(fixed.fdvUsd, '500000');
  });

  it('fails closed when raw evidence or the frozen V4 quote slot is unavailable', () => {
    assert.deepEqual(recomputeSpot(spotRow('uniswap-v3', { log_data: null })), {
      skip: 'missing_raw_log',
    });
    assert.deepEqual(recomputeSpot(spotRow('uniswap-v4', { quote_index: null })), {
      skip: 'missing_quote_index',
    });
  });

  it('dry-runs one bounded batch and reports its durable evidence source', async () => {
    let served = false;
    const row = {
      ...spotRow('uniswap-v3'),
      chain: 'robinhood', transaction_hash: '0xabc', log_index: '7', block_number: '10',
      price_quote: '0.5', price_usd: '1', fdv_usd: '1000000',
      evidence_source: 'backfill-staging',
    };
    const database = {
      async query() {
        if (served) return { rows: [] };
        served = true;
        return { rows: [row] };
      },
    };
    const summary = await repairSpot(database, {
      mode: 'dry-run', batchSize: 500, fromBlock: '0', toBlock: '20',
      checkpoint: null, maxBatches: 0,
    });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.wouldRepair, 1);
    assert.equal(summary.sources['backfill-staging'], 1);
    assert.equal(summary.complete, true);
  });

  it('aborts a write batch before updating when any evidence is incomplete', async () => {
    const row = {
      ...spotRow('uniswap-v4', { quote_index: null }),
      transaction_hash: '0xabc', log_index: '7', block_number: '10',
      evidence_source: 'head-capture',
    };
    const database = { query: async () => ({ rows: [row] }) };
    await assert.rejects(() => repairSpot(database, {
      mode: 'write', batchSize: 500, fromBlock: '0', toBlock: '20',
      checkpoint: `/tmp/unused-spot-repair-checkpoint-${process.pid}.json`, maxBatches: 1,
    }), /stopped on incomplete evidence/);
  });

  it('requires fixed bounds and a checkpoint before spot writes', () => {
    assert.throws(() => parseArgs(['--target', 'spot']), /requires valid --from-block/);
    assert.throws(() => parseArgs([
      '--target', 'spot', '--mode', 'write', '--from-block', '1', '--to-block', '2',
    ]), /requires --checkpoint/);
    assert.deepEqual(parseArgs([
      '--target', 'spot', '--from-block', '1', '--to-block', '2',
    ]), {
      mode: 'dry-run', batchSize: 500, target: 'spot', fromBlock: '1', toBlock: '2',
      checkpoint: null, maxBatches: 1, onMissing: 'stop', sleepMs: 0,
    });
    assert.throws(() => parseArgs([
      '--target', 'spot', '--from-block', '1', '--to-block', '2', '--on-missing', 'bogus',
    ]), /on-missing must be stop or skip/);
  });

  it('repairs the recomputable rows and tallies the rest when on-missing is skip', async () => {
    let served = false;
    const good = {
      ...spotRow('uniswap-v3'),
      chain: 'robinhood', transaction_hash: '0xgood', log_index: '1', block_number: '10',
      price_quote: '0.5', price_usd: '1', fdv_usd: '1000000', evidence_source: 'backfill-staging',
    };
    const missing = {
      ...spotRow('uniswap-v3', { log_data: null }),
      chain: 'robinhood', transaction_hash: '0xmissing', log_index: '2', block_number: '11',
      price_quote: '0.5', price_usd: '1', fdv_usd: '1000000', evidence_source: null,
    };
    const updates = [];
    const database = {
      async query(sql, params) {
        if (/UPDATE robinhood_market_observations/.test(sql)) {
          updates.push(JSON.parse(params[0]));
          return { rowCount: JSON.parse(params[0]).length };
        }
        if (served) return { rows: [] };
        served = true;
        return { rows: [good, missing] };
      },
    };

    const summary = await repairSpot(database, {
      mode: 'write', batchSize: 500, fromBlock: '0', toBlock: '20',
      checkpoint: null, maxBatches: 0, onMissing: 'skip', sleepMs: 0,
    });

    assert.equal(summary.repaired, 1);
    assert.equal(summary.skipped.missing_raw_log, 1);
    assert.equal(summary.complete, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0][0].transaction_hash, '0xgood');
  });
});

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

  it('suppresses repaired FDV above the runtime 1e15 human-supply ceiling', () => {
    const fixed = recomputeTransposed(transposedRow({
      token_total_supply_raw: (1_000_000_000_000_001n * ONE).toString(),
    }));
    assert.equal(fixed.priceUsd, '2.5');
    assert.equal(fixed.volumeUsd, '5');
    assert.equal(fixed.fdvUsd, null);
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

describe('invalid-supply FDV pass', () => {
  it('uses the runtime human-supply ceiling in the cleanup predicate', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ n: 2 }] };
      },
    };

    const summary = await repairUncapped(database, { mode: 'dry-run' });

    assert.equal(summary.candidates, 2);
    assert.match(calls[0].sql, /power\(10::numeric, token_decimals\)/);
    assert.deepEqual(calls[0].params, ['1000000000000000']);
  });

  it('runs supply cleanup alone without walking transposition candidates', async () => {
    const calls = [];
    const database = {
      async query(sql) {
        calls.push(sql);
        if (/COUNT/.test(sql)) return { rows: [{ n: 2 }] };
        return { rowCount: 2 };
      },
    };

    const summary = await runRepair({
      mode: 'write', target: 'supply', batchSize: 500,
    }, { database });

    assert.deepEqual(summary, {
      mode: 'write', target: 'supply', supply: { candidates: 2, cleared: 2 },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((sql) => !/fdv_usd::numeric > \$1/.test(sql)));
    assert.equal(parseArgs(['--target', 'supply']).target, 'supply');
  });
});

describe('v2/v3 transposition pass', () => {
  it('cannot select v4 observations through the general repair target', async () => {
    const calls = [];
    const database = {
      async query(sql) {
        calls.push(sql);
        if (/COUNT/.test(sql)) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
    };

    await repairTransposed(database, { mode: 'dry-run', batchSize: 500 });

    assert.equal(calls.length, 2);
    assert.ok(calls.every((sql) => (
      /protocol IN \('uniswap-v2', 'uniswap-v3'\)/.test(sql)
    )));
  });
});
