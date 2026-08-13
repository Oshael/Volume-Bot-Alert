const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');
const esbuild = require('../frontend/node_modules/esbuild');

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM = '0xabcdef0123456789abcdef0123456789abcdef01';
let marketEvents;

before(async () => {
  const result = await esbuild.build({
    entryPoints: ['frontend/src/services/socket/market-events.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  marketEvents = await import(`data:text/javascript;base64,${source}`);
});

function event(overrides = {}) {
  return {
    type: 'market:bucket',
    chain: 'robinhood',
    address: EVM,
    bucketTs: '2026-07-15T12:00:00.000Z',
    sequence: 'robinhood:000000000000000080690001:000000000000000080690000:000000000000000000000007',
    granularityMinutes: 1,
    candle: {
      bucketTs: '2026-07-15T12:00:00.000Z',
      granularityMinutes: 1,
      closeFdvUsd: 120000,
      closePrice: 0.12,
    },
    ...overrides,
  };
}

describe('frontend realtime market events', () => {
  it('normalizes subscriptions to canonical chain identities', () => {
    assert.deepEqual(marketEvents.normalizeMarketSubscription(EVM.toUpperCase(), 'robinhood'), {
      chain: 'robinhood',
      address: EVM,
      key: `robinhood:${EVM}`,
    });
    assert.equal(marketEvents.normalizeMarketSubscription(SOLANA)?.key, `solana:${SOLANA}`);
    assert.equal(marketEvents.normalizeMarketSubscription(EVM), null);
  });

  it('requires an explicit valid event identity, timestamp, sequence and candle', () => {
    const normalized = marketEvents.normalizeMarketBucketUpdate(event());
    assert.equal(normalized.chain, 'robinhood');
    assert.equal(normalized.address, EVM);
    assert.equal(normalized.candle.closeFdvUsd, 120000);
    assert.equal(marketEvents.normalizeMarketBucketUpdate(event({ chain: undefined })), null);
    assert.equal(marketEvents.normalizeMarketBucketUpdate(event({ chain: null })), null);
    assert.equal(marketEvents.normalizeMarketBucketUpdate(event({ sequence: '' })), null);
    assert.equal(marketEvents.normalizeMarketBucketUpdate(event({ bucketTs: 'invalid' })), null);
    assert.equal(marketEvents.normalizeMarketBucketUpdate(event({ candle: null })), null);
  });

  it('coalesces only updates for the same token source bucket', () => {
    const current = marketEvents.normalizeMarketBucketUpdate(event());
    const newerSequence = marketEvents.normalizeMarketBucketUpdate(event({
      sequence: 'robinhood:000000000000000080690002:000000000000000080690001:000000000000000000000001',
    }));
    const previousBucket = marketEvents.normalizeMarketBucketUpdate(event({
      bucketTs: '2026-07-15T11:59:00.000Z',
      candle: { ...event().candle, bucketTs: '2026-07-15T11:59:00.000Z' },
    }));

    assert.equal(marketEvents.getMarketBucketFrameKey(current), marketEvents.getMarketBucketFrameKey(newerSequence));
    assert.notEqual(marketEvents.getMarketBucketFrameKey(current), marketEvents.getMarketBucketFrameKey(previousBucket));
  });

  it('normalizes Robinhood trades and rejects malformed identities', () => {
    const trade = {
      type: 'market:trade', chain: 'robinhood', address: EVM.toUpperCase(),
      transactionHash: `0x${'1'.repeat(64)}`, actionIndex: 4, blockNumber: 100,
      blockTime: '2026-08-09T12:00:00Z', side: 'sell',
      walletAddress: `0x${'2'.repeat(40)}`, amountUsd: '7.5', priceUsd: null, mcUsd: '9000',
    };
    const normalized = marketEvents.normalizeMarketTradeUpdate(trade);
    assert.equal(normalized.address, EVM);
    assert.equal(normalized.amountUsd, 7.5);
    assert.equal(normalized.priceUsd, null);
    assert.equal(marketEvents.normalizeMarketTradeUpdate({ ...trade, chain: 'base' }), null);
    assert.equal(marketEvents.normalizeMarketTradeUpdate({ ...trade, transactionHash: 'bad' }), null);
  });

  it('rejects duplicate and older updates only within the same source bucket', () => {
    const gate = marketEvents.createMarketEventOrderGate(4);
    const current = marketEvents.normalizeMarketBucketUpdate(event());
    const older = marketEvents.normalizeMarketBucketUpdate(event({
      sequence: 'robinhood:000000000000000080690000:000000000000000080689999:000000000000000000000001',
    }));
    const newer = marketEvents.normalizeMarketBucketUpdate(event({
      sequence: 'robinhood:000000000000000080690002:000000000000000080690001:000000000000000000000001',
    }));
    const previousBucket = marketEvents.normalizeMarketBucketUpdate(event({
      bucketTs: '2026-07-15T11:59:00.000Z',
      candle: { ...event().candle, bucketTs: '2026-07-15T11:59:00.000Z' },
    }));

    assert.equal(gate.accept(current), true);
    assert.equal(gate.accept(current), false);
    assert.equal(gate.accept(older), false);
    assert.equal(gate.accept(newer), true);
    assert.equal(gate.accept(previousBucket), true);
  });

  it('clears ordering state only for the unsubscribed canonical identity', () => {
    const gate = marketEvents.createMarketEventOrderGate();
    const robinhood = marketEvents.normalizeMarketBucketUpdate(event());
    const base = marketEvents.normalizeMarketBucketUpdate(event({ chain: 'base' }));
    assert.equal(gate.accept(robinhood), true);
    assert.equal(gate.accept(base), true);

    gate.clearIdentity({ chain: 'robinhood', address: EVM });
    assert.equal(gate.accept(robinhood), true);
    assert.equal(gate.accept(base), false);
  });

  it('replaces visible close only for a newer source bucket or sequence', () => {
    const compareClose = marketEvents.shouldReplaceMarketCandleClose;
    const currentTs = '2026-07-15T12:00:00.000Z';
    assert.equal(compareClose(currentTs, 'source:2', '2026-07-15T12:01:00.000Z', 'source:1'), true);
    assert.equal(compareClose(currentTs, 'source:2', '2026-07-15T11:59:00.000Z', 'source:9'), false);
    assert.equal(compareClose(currentTs, 'source:2', currentTs, 'source:3'), true);
    assert.equal(compareClose(currentTs, 'source:2', currentTs, 'source:2'), false);
    assert.equal(compareClose(currentTs, 'source:2', currentTs, 'source:1'), false);
  });

  it('builds a fresh FDV patch with monotonic committed activity deltas', () => {
    const patch = marketEvents.buildRealtimeTokenMarketPatch(
      marketEvents.normalizeMarketBucketUpdate(event({
        activity: {
          volumeUsd: '450.25',
          swaps: 3,
          volume5mUsd: '1250.5',
          volume1hUsd: 4200,
          volume6hUsd: 9900,
          volume24hUsd: 21500,
        },
        coverage: { '5m': 'complete', '1h': 'complete', '6h': 'partial', '24h': 'partial' },
        valuation: {
          type: 'fdv',
          fdvUsd: '120000',
          priceUsd: '0.12',
          observedAt: '2026-07-15T12:00:20.000Z',
        },
      })),
    );

    assert.equal(patch.fdv, 120000);
    assert.equal(patch.mcap, null);
    assert.equal(patch.priceUsd, 0.12);
    assert.deepEqual(patch.valuation, {
      type: 'fdv', usd: 120000, observedAt: '2026-07-15T12:00:20.000Z', freshness: 'fresh',
    });
    assert.deepEqual(patch.rollingVolumes, {
      volume5m: 1250.5,
      volume1h: 4200,
      volume6h: 9900,
      volume24h: 21500,
    });
    assert.deepEqual(patch.volumeCoverage, {
      '5m': 'complete',
      '1h': 'complete',
      '6h': 'partial',
      '24h': 'partial',
    });
    assert.deepEqual(patch.activity, {
      bucketTs: '2026-07-15T12:00:00.000Z',
      volumeUsd: 450.25,
      swaps: 3,
      volumeDeltaUsd: 450.25,
      swapsDelta: 3,
      canonicalVolume5m: null,
    });

    const advanced = marketEvents.buildRealtimeTokenMarketPatch(
      marketEvents.normalizeMarketBucketUpdate(event({
        activity: { volumeUsd: '500', swaps: 5 },
      })),
      { bucketTs: event().bucketTs, volumeUsd: 450.25, swaps: 3 },
    );
    assert.equal(advanced.activity.volumeDeltaUsd, 49.75);
    assert.equal(advanced.activity.swapsDelta, 2);

    const alreadyIncluded = marketEvents.buildRealtimeTokenMarketPatch(
      marketEvents.normalizeMarketBucketUpdate(event({
        activity: { volumeUsd: '500', swaps: 5 },
      })),
      { windowEnd: '2026-07-15T12:01:00.000Z' },
    );
    assert.equal(alreadyIncluded.activity.volumeDeltaUsd, 0);
    assert.equal(alreadyIncluded.activity.swapsDelta, 0);

    const degraded = marketEvents.buildRealtimeTokenMarketPatch(
      marketEvents.normalizeMarketBucketUpdate(event({
        activity: { swaps: 1 },
        valuation: { type: 'fdv', fdvUsd: 'invalid' },
      })),
    );
    assert.equal(degraded.valuationType, null);
    assert.equal(degraded.valuation, null);
    assert.equal(degraded.activity.swapsDelta, 1);
  });

  it('applies canonical 5m windows and preserves an omitted same-window baseline', () => {
    const activity = {
      volumeUsd: '25', swaps: 1,
      currentVolume5mUsd: '120', prevVolume5mCanonical: '80',
      volume5mBaselineAt: '2026-07-15T11:55:00.000Z',
      volume5mWindowEnd: '2026-07-15T12:00:00.000Z',
      volume5mDeltaCoverage: 'complete',
    };
    const current = marketEvents.buildRealtimeTokenMarketPatch(
      marketEvents.normalizeMarketBucketUpdate(event({ activity })),
    );
    assert.deepEqual(current.activity.canonicalVolume5m, {
      currentVolumeUsd: 120,
      previousVolumeUsd: 80,
      baselineAt: '2026-07-15T11:55:00.000Z',
      windowEnd: '2026-07-15T12:00:00.000Z',
      coverage: 'complete',
    });

    const withoutBaseline = { ...activity };
    delete withoutBaseline.prevVolume5mCanonical;
    delete withoutBaseline.volume5mBaselineAt;
    const merged = marketEvents.buildRealtimeTokenMarketPatch(
      marketEvents.normalizeMarketBucketUpdate(event({ activity: withoutBaseline })),
      {
        prevVolume5mCanonical: 80,
        volume5mBaselineAt: '2026-07-15T11:55:00.000Z',
        volume5mWindowEnd: '2026-07-15T12:00:00.000Z',
      },
    );
    assert.equal(merged.activity.canonicalVolume5m.previousVolumeUsd, 80);
    assert.equal(merged.activity.canonicalVolume5m.coverage, 'complete');
  });

  it('builds a Robinhood live chart candle without falling back to market cap', () => {
    const candle = marketEvents.buildLiveTokenChartCandle(
      marketEvents.normalizeMarketBucketUpdate(event({
        candle: {
          ...event().candle,
          openFdvUsd: '110000', highFdvUsd: '125000', lowFdvUsd: '105000',
          closeFdvUsd: '120000', openMcap: 999999, sampleCount: '3',
        },
        valuation: { type: 'fdv', fdvUsd: '120000' },
      })),
    );

    assert.equal(candle.valuationType, 'fdv');
    assert.equal(candle.openFdvUsd, 110000);
    assert.equal(candle.closeFdvUsd, 120000);
    assert.equal(candle.openMcap, 999999);
    assert.equal(candle.sampleCount, 3);
    assert.equal(candle.liveSequence, event().sequence);
  });
});
