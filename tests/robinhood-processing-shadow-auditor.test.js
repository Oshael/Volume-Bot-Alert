const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodProcessingShadowAuditor,
  __private,
} = require('../src/services/robinhood-processing-shadow-auditor');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

function expected(transactionHash, logIndex, overrides = {}) {
  return {
    transactionHash, logIndex: String(logIndex), blockNumber: '100',
    protocol: 'uniswap-v3', marketKey: 'robinhood:uniswap-v3:test',
    tokenAddress: '0x1111111111111111111111111111111111111111',
    quoteAddress: '0x2222222222222222222222222222222222222222',
    side: 'buy', status: 'accepted', rejectionReason: null,
    observedAt: '2026-08-05T18:00:00.000Z', tokenDecimals: 18, quoteDecimals: 18,
    tokenTotalSupplyRaw: '1000', tokenSupplyStatus: 'exact_block_call',
    tokenSupplyAnchorBlockNumber: '100', tokenAmountRaw: '10', quoteAmountRaw: '1',
    tokenAmount: '10', quoteAmount: '1', priceQuote: '0.1', quoteUsdPrice: '2000',
    priceUsd: '200', volumeUsd: '2000', fdvUsd: '200000', marketCapUsd: null,
    valuationType: 'fdv', quoteUsdSource: 'weth', quoteUsdStatus: 'observed',
    liquidityUsd: '30000', liquidityRaw: '15', liquidityStatus: 'spot_tvl_from_pool_balances',
    liquidityConfidence: 'medium', liquidityWarning: null,
    ...overrides,
  };
}

function canonical(row, overrides = {}) {
  return Object.fromEntries([
    ['transaction_hash', row.transactionHash], ['log_index', row.logIndex],
    ...__private.FIELD_PAIRS.map(([expectedKey, actualKey]) => [actualKey, row[expectedKey]]),
    ...Object.entries(overrides),
  ]);
}

function auditor(rows, options = {}) {
  const calls = [];
  const warnings = [];
  return {
    calls, warnings,
    value: createRobinhoodProcessingShadowAuditor({
      database: { query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } },
      normalize: (entry) => entry,
      logger: { warn: (...args) => warnings.push(args) },
      ...options,
    }),
  };
}

describe('Robinhood processing shadow auditor', () => {
  it('compares canonical rows, normalizes decimal scale, and reports missing identities', async () => {
    const match = expected(HASH_A, 1);
    const mismatch = expected(HASH_B, 2);
    const missing = expected(HASH_C, 3);
    const fixture = auditor([
      canonical(match, { price_usd: '200.0000' }),
      canonical(mismatch, { liquidity_status: 'requires_tick_liquidity_distribution' }),
    ]);

    const result = await fixture.value.compare([match, mismatch, missing]);

    assert.deepEqual(
      { attempted: result.attempted, compared: result.compared, matched: result.matched,
        mismatched: result.mismatched, missing: result.missing },
      { attempted: 3, compared: 2, matched: 1, mismatched: 1, missing: 1 }
    );
    assert.deepEqual(result.samples[0].fields, ['liquidityStatus']);
    assert.deepEqual(result.samples[1].fields, ['canonicalObservation']);
    assert.match(fixture.calls[0].sql, /robinhood_market_observations/);
    assert.equal(fixture.warnings.length, 1);
  });

  it('bounds divergence samples without changing aggregate counts', async () => {
    const entries = [expected(HASH_A, 1), expected(HASH_B, 2), expected(HASH_C, 3)];
    const fixture = auditor([], { sampleLimit: 1 });

    const result = await fixture.value.compare(entries);

    assert.equal(result.missing, 3);
    assert.equal(result.samples.length, 1);
  });

  it('does no query when the batch has no observations', async () => {
    const fixture = auditor([]);
    const result = await fixture.value.compare([]);

    assert.equal(result.attempted, 0);
    assert.equal(fixture.calls.length, 0);
  });

  it('uses the dedicated statement timeout when the database supports it', async () => {
    const calls = [];
    const value = createRobinhoodProcessingShadowAuditor({
      database: {
        query: async () => { throw new Error('unbounded query must not run'); },
        queryWithStatementTimeout: async (sql, params, timeoutMs) => {
          calls.push({ sql, params, timeoutMs });
          return { rows: [] };
        },
      },
      normalize: (entry) => entry,
      statementTimeoutMs: 750,
      logger: { warn() {} },
    });

    await value.compare([expected(HASH_A, 1)]);

    assert.equal(calls[0].timeoutMs, 750);
  });
});
