const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodStandardAlertSignalSource,
  __private,
} = require('../src/services/robinhood-standard-alert-signal-source');

const TOKEN = `0x${'1'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v3:0x${'2'.repeat(40)}`;
const AS_OF = '2026-07-19T18:00:30.000Z';

function bucket(overrides = {}) {
  return {
    tokenAddress: TOKEN,
    valuationProtocol: 'uniswap-v3',
    valuationMarketKey: MARKET,
    lastObservedAt: '2026-07-19T18:00:20.000Z',
    lastBlockNumber: '100', lastLogIndex: '2',
    closePriceUsd: '2', closeFdvUsd: '200',
    currentVolume5mUsd: '300', prevVolume5mCanonical: '100',
    volume5mBaselineAt: '2026-07-19T17:55:30.000Z',
    volume5mWindowEnd: AS_OF, volume5mDeltaCoverage: 'complete',
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    token_address: TOKEN,
    protocol: 'uniswap-v3', market_key: MARKET,
    token_created_at: new Date('2026-07-10T18:00:00.000Z'),
    token_age_source: 'token-catalog', admin_blocked: false,
    coverage_start_at: new Date('2026-07-01T00:00:00.000Z'),
    coverage_end_at: new Date(AS_OF), caught_up: true,
    price_5m_usd: '1.5', fdv_5m_usd: '150',
    observed_5m_at: new Date('2026-07-19T17:55:00.000Z'),
    price_1h_usd: '1', fdv_1h_usd: '100',
    observed_1h_at: new Date('2026-07-19T17:00:00.000Z'),
    price_6h_usd: '0.5', fdv_6h_usd: '50',
    observed_6h_at: new Date('2026-07-19T12:00:00.000Z'),
    ...overrides,
  };
}

function cursor() {
  return { nextBlock: '101', checkpointTimestamp: new Date(AS_OF) };
}

describe('Robinhood standard alert signal source', () => {
  it('builds canonical volume and FDV signals from a targeted committed token', async () => {
    const calls = [];
    const source = createRobinhoodStandardAlertSignalSource({
      database: {
        async queryWithStatementTimeout(sql, params, timeout) {
          calls.push({ sql, params, timeout });
          return { rows: [context()] };
        },
      },
    });
    const [signal] = await source.buildFromCommittedBuckets({
      buckets: [bucket()], cursor: cursor(),
    });

    assert.equal(signal.id, `robinhood:${TOKEN}:101`);
    assert.deepEqual(signal.volume5m, {
      currentUsd: 300, baselineUsd: 100, changePct: 200,
      baselineAt: '2026-07-19T17:55:30.000Z', windowEnd: AS_OF, coverage: 'complete',
    });
    assert.equal(signal.valuation.type, 'fdv');
    assert.equal(signal.valuation.current.marketKey, MARKET);
    assert.deepEqual(signal.valuation.windows['5m'], {
      baselineAt: '2026-07-19T17:55:00.000Z', priceUsd: 1.5, fdvUsd: 150,
      coverage: 'complete', priceChangePct: 33.33333333333333, fdvChangePct: 33.33333333333333,
    });
    assert.deepEqual(signal.valuation.windows['1h'], {
      baselineAt: '2026-07-19T17:00:00.000Z', priceUsd: 1, fdvUsd: 100,
      coverage: 'complete', priceChangePct: 100, fdvChangePct: 100,
    });
    assert.equal(signal.valuation.windows['6h'].fdvChangePct, 300);
    assert.equal(signal.tokenAge.bucket, '7d-plus');
    assert.equal(signal.tokenAge.source, 'token-catalog');
    assert.equal(signal.tokenAge.eligibility.oldWeekSurge, true);
    assert.deepEqual(signal.filters, { adminBlocked: false });
    assert.deepEqual(JSON.parse(calls[0].params[0]), [{
      token_address: TOKEN, protocol: 'uniswap-v3', market_key: MARKET,
    }]);
    assert.equal(calls[0].params[1].toISOString(), AS_OF);
    assert.equal(calls[0].timeout, 10_000);
    assert.match(calls[0].sql, /bucket\.market_key = context\.market_key/);
    assert.doesNotMatch(calls[0].sql, /https?:\/\//);
  });

  it('fails closed when cursor or baseline coverage is incomplete', () => {
    const signal = __private.buildSignal(bucket(), context({
      coverage_start_at: new Date('2026-07-19T17:30:00.000Z'),
      observed_1h_at: null,
    }), cursor(), new Date(AS_OF));

    assert.equal(signal.valuation.windows['1h'].coverage, 'unavailable');
    assert.equal(signal.valuation.windows['1h'].fdvChangePct, null);
    assert.equal(signal.valuation.windows['6h'].coverage, 'partial');
    assert.equal(signal.valuation.windows['6h'].priceChangePct, null);
  });

  it('deduplicates touched minutes deterministically for replay-safe input', async () => {
    const database = { async query() { return { rows: [context()] }; } };
    const source = createRobinhoodStandardAlertSignalSource({ database });
    const input = {
      buckets: [bucket({ lastLogIndex: '1' }), bucket({ lastLogIndex: '3' })],
      cursor: cursor(),
    };
    const first = await source.buildFromCommittedBuckets(input);
    const replay = await source.buildFromCommittedBuckets(input);

    assert.equal(first.length, 1);
    assert.equal(first[0].id, replay[0].id);
    assert.deepEqual(first, replay);
  });
});
