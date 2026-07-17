const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const dashboard = require('../src/routes/dashboard');
const backendAlertFeed = require('../src/services/backend-alert-feed');

describe('Robinhood dashboard valuation contract', () => {
  it('exposes FDV without fabricating market cap', () => {
    const valuation = dashboard.__private.buildValuationPayload({
      chain: 'robinhood',
      last_mcap: null,
      last_fdv: '500000.25',
    });

    assert.deepEqual(valuation, {
      mcap: null,
      fdv: 500000.25,
      valuationType: 'fdv',
    });
  });

  it('keeps real market cap authoritative when both valuations exist', () => {
    const metrics = backendAlertFeed.__private.buildDashboardUserAlertMetricPayload({}, {
      last_mcap: '400000',
      last_fdv: '500000',
    });

    assert.equal(metrics.mcap, 400000);
    assert.equal(metrics.fdv, 500000);
    assert.equal(metrics.valuationType, 'market-cap');
  });

  it('preserves the V2 signal metrics used by the Robinhood alert card', () => {
    const metrics = backendAlertFeed.__private.buildDashboardUserAlertMetricPayload({
      priceUsd: 0.0042,
      liquidityUsd: 5000,
      transactions: 15,
      volume5m: 2000,
    }, {});

    assert.equal(metrics.priceUsd, 0.0042);
    assert.equal(metrics.liquidityUsd, 5000);
    assert.equal(metrics.transactions, 15);
    assert.equal(metrics.volume5m, 2000);
  });
});
