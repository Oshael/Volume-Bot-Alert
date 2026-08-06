const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodDerivedStandardAlertSink,
} = require('../src/services/robinhood-derived-standard-alert-sink');

const TOKEN = `0x${'1'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v3:0x${'2'.repeat(40)}`;
const NOW = Date.parse('2026-08-05T21:00:30.000Z');

function payload(overrides = {}) {
  return {
    type: 'market:bucket', chain: 'robinhood', address: TOKEN,
    market: { protocol: 'uniswap-v3', key: MARKET },
    ordering: {
      cursorNextBlock: '101', frontierTimestamp: '2026-08-05T21:00:30.000Z',
      lastBlockNumber: '100', lastLogIndex: '7',
    },
    generatedAt: '2026-08-05T21:00:30.010Z',
    activity: {
      currentVolume5mUsd: '300', prevVolume5mCanonical: '100',
      volume5mBaselineAt: '2026-08-05T20:55:30.000Z',
      volume5mWindowEnd: '2026-08-05T21:00:30.000Z',
      volume5mDeltaCoverage: 'complete',
    },
    valuation: {
      priceUsd: 2, fdvUsd: 200, observedAt: '2026-08-05T21:00:20.000Z',
    },
    derived: { standardAlertEligible: true },
    ...overrides,
  };
}

describe('robinhood derived standard alert sink', () => {
  it('rebuilds the committed-bucket contract and publishes only when both gates allow it', async () => {
    const calls = { source: [], publication: [] };
    const sink = createRobinhoodDerivedStandardAlertSink({
      now: () => NOW,
      alertsRequested: true,
      publishable: true,
      source: {
        buildFromCommittedBuckets: async (input) => {
          calls.source.push(input);
          return [{ id: 'signal-1' }];
        },
      },
      publication: {
        consume: async (input) => {
          calls.publication.push(input);
          return { status: 'completed', persisted: 1 };
        },
      },
    });

    const result = await sink.consume(payload());

    assert.equal(result.persisted, 1);
    assert.equal(calls.source[0].buckets[0].valuationMarketKey, MARKET);
    assert.equal(calls.source[0].cursor.nextBlock, '101');
    assert.equal(calls.source[0].cursor.coverageCaughtUp, true);
    assert.equal(calls.publication[0].alertsRequested, true);
    assert.equal(calls.publication[0].publishable, true);
    assert.equal(sink.getStatus().publishedRuns, 1);
  });

  it('never upgrades publication when the global alert intent is off', async () => {
    const publicationCalls = [];
    const sink = createRobinhoodDerivedStandardAlertSink({
      now: () => NOW,
      alertsRequested: false,
      publishable: true,
      source: { buildFromCommittedBuckets: async () => [] },
      publication: { consume: async (input) => { publicationCalls.push(input); return {}; } },
    });

    await sink.consume(payload());

    assert.equal(publicationCalls[0].publishable, false);
    assert.equal(sink.getStatus().disabledRuns, 1);
  });

  it('runs in shadow when upstream worker health is not ready', async () => {
    const publicationCalls = [];
    const sink = createRobinhoodDerivedStandardAlertSink({
      now: () => NOW,
      alertsRequested: true,
      publishable: true,
      healthProvider: async () => ({ ready: false, blockers: ['processing_tick_stale'] }),
      source: { buildFromCommittedBuckets: async () => [{ id: 'signal-1' }] },
      publication: { consume: async (input) => { publicationCalls.push(input); return {}; } },
    });

    await sink.consume(payload());

    assert.equal(publicationCalls[0].publishable, false);
    assert.equal(sink.getStatus().shadowRuns, 1);
    assert.deepEqual(sink.getStatus().lastSummary.healthBlockers, ['processing_tick_stale']);
  });

  it('skips old/out-of-batch payloads before querying signal baselines', async () => {
    let sourceCalls = 0;
    const sink = createRobinhoodDerivedStandardAlertSink({
      now: () => NOW,
      source: { buildFromCommittedBuckets: async () => { sourceCalls += 1; return []; } },
      publication: { consume: async () => ({}) },
    });

    const ineligible = await sink.consume(payload({ derived: {} }));
    const stale = await sink.consume(payload({
      valuation: { priceUsd: 2, fdvUsd: 200, observedAt: '2026-08-05T20:00:00.000Z' },
    }));

    assert.equal(ineligible.reason, 'not_latest_bucket_in_commit');
    assert.equal(stale.reason, 'stale_event');
    assert.equal(sourceCalls, 0);
  });

  it('throws signal/publication failures so the outbox row remains retryable', async () => {
    const sink = createRobinhoodDerivedStandardAlertSink({
      now: () => NOW,
      source: { buildFromCommittedBuckets: async () => { throw new Error('baseline unavailable'); } },
      publication: { consume: async () => ({}) },
    });

    await assert.rejects(sink.consume(payload()), /baseline unavailable/);
    assert.equal(sink.getStatus().errors, 1);
  });
});
