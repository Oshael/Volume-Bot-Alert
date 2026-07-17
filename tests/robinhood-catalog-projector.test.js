const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const robinhoodCatalog = require('../src/models/robinhood-catalog');
const { createRobinhoodCatalogProjector } = require(
  '../src/services/robinhood-catalog-projector'
);

const TOKEN = `0x${'1'.repeat(40)}`;
const PAIR = `0x${'2'.repeat(40)}`;
const CANDIDATE = Object.freeze({
  chain: 'robinhood',
  protocol: 'uniswap-v2',
  marketKey: `robinhood:uniswap-v2:${PAIR}`,
  tokenAddress: TOKEN,
  discoveredAt: '2026-07-14T16:00:00.000Z',
  lastObservedAt: '2026-07-14T17:00:00.000Z',
  windowMs: 300000,
  lastPriceUsd: '1.25',
  lastFdvUsd: '500000',
  volumeUsd: '12000',
  liquidityUsd: '30000',
});
const DECISION = Object.freeze({
  chain: 'robinhood',
  protocol: 'uniswap-v2',
  marketKey: CANDIDATE.marketKey,
  tokenAddress: TOKEN,
  expectedSignal: true,
  publishable: true,
});

describe('Robinhood catalog staging', () => {
  it('is fail-closed before attempting a catalog write', async () => {
    let writes = 0;
    const projector = createRobinhoodCatalogProjector({
      catalog: { stageSnapshot: async () => { writes += 1; } },
    });

    assert.equal((await projector.stage(CANDIDATE, DECISION, {})).reason, 'alerts_disabled');
    assert.equal((await projector.stage(CANDIDATE, DECISION, {
      alertsRequested: true,
      publishable: false,
    })).reason, 'rollout_not_publishable');
    assert.equal((await projector.stage(CANDIDATE, {
      ...DECISION,
      publishable: false,
    }, {
      alertsRequested: true,
      publishable: true,
    })).reason, 'decision_not_publishable');
    assert.equal(writes, 0);
  });

  it('stages an authorized V2 decision without activating monitoring', async () => {
    const calls = [];
    const projector = createRobinhoodCatalogProjector({
      catalog: {
        async stageSnapshot(candidate) {
          calls.push(candidate);
          return { chain: 'robinhood', address: TOKEN, eligible_for_monitoring: false };
        },
      },
    });

    const result = await projector.stage(CANDIDATE, DECISION, {
      alertsRequested: true,
      publishable: true,
    });

    assert.equal(result.status, 'staged');
    assert.equal(result.row.eligible_for_monitoring, false);
    assert.deepEqual(calls, [CANDIDATE]);
  });

  it('persists only honest catalog metrics and leaves FDV out of market cap', async () => {
    const calls = [];
    const row = await robinhoodCatalog.stageSnapshot(CANDIDATE, {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ chain: 'robinhood', address: params[0] }] };
      },
    });

    assert.deepEqual(row, { chain: 'robinhood', address: TOKEN });
    assert.match(calls[0].sql, /last_vol_5m/);
    assert.match(calls[0].sql, /last_fdv/);
    assert.doesNotMatch(calls[0].sql, /last_mcap/);
    assert.match(calls[0].sql, /FALSE, FALSE/);
    assert.deepEqual(calls[0].params.slice(3), ['1.25', '500000', '12000', '30000', PAIR]);
  });
});
