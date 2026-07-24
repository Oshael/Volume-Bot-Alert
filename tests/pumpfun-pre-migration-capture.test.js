const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const solPrice = require('../src/services/sol-price');
const capture = require('../src/services/pumpfun-pre-migration-capture');

const VALID_MINT = 'So11111111111111111111111111111111111111112';

afterEach(() => {
  capture.__private.resetStatus();
});

describe('PumpFun pre-migration capture', () => {
  it('does nothing while disabled', async () => {
    const originalMarket = tokenMarketBucket1m.upsertSnapshotBucket;
    let marketCalls = 0;
    tokenMarketBucket1m.upsertSnapshotBucket = async () => {
      marketCalls += 1;
    };

    try {
      capture.start({ enabled: false });
      const result = await capture.handleEvent({
        type: 'create',
        data: { mint: VALID_MINT, marketCapSol: 100 },
        now: '2026-04-27T10:00:00.000Z',
      });

      assert.equal(result, null);
      assert.equal(marketCalls, 0);
      assert.equal(capture.getStatus().enabled, false);
    } finally {
      tokenMarketBucket1m.upsertSnapshotBucket = originalMarket;
    }
  });

  it('persists pre-migration market buckets from PumpPortal create events', async () => {
    const originalMarket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalSolPrice = solPrice.getPrice;
    const marketCalls = [];
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => {
      marketCalls.push(payload);
      return payload;
    };
    solPrice.getPrice = () => 150;

    try {
      capture.start({ enabled: true, maxTracked: 10 });
      await capture.handleEvent({
        type: 'create',
        data: {
          mint: VALID_MINT,
          symbol: 'FAST',
          name: 'Fast Token',
          marketCapSol: 200,
        },
        now: '2026-04-27T10:00:00.000Z',
      });

      assert.equal(marketCalls.length, 1);
      assert.equal(marketCalls[0].tokenAddress, VALID_MINT);
      assert.equal(marketCalls[0].mcap, 30000);
      assert.equal(marketCalls[0].source, 'pumpfun-pre-migration');
      assert.equal(capture.getStatus().trackedCount, 1);
    } finally {
      tokenMarketBucket1m.upsertSnapshotBucket = originalMarket;
      solPrice.getPrice = originalSolPrice;
    }
  });

  it('persists rolling volume buckets from pre-migration trades', async () => {
    const originalMarket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalVolume = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const originalSolPrice = solPrice.getPrice;
    const marketCalls = [];
    const volumeCalls = [];
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => {
      marketCalls.push(payload);
      return payload;
    };
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => {
      volumeCalls.push(payload);
      return payload;
    };
    solPrice.getPrice = () => 100;

    try {
      capture.start({ enabled: true, maxTracked: 10 });
      await capture.handleEvent({
        type: 'trade',
        data: { mint: VALID_MINT, marketCapSol: 250, solAmount: 2 },
        now: '2026-04-27T10:01:00.000Z',
      });

      assert.equal(volumeCalls.length, 1);
      assert.equal(marketCalls[0].vol5m, 200);
      assert.equal(marketCalls[0].vol24h, 200);
      assert.equal(volumeCalls[0].tokenAddress, VALID_MINT);
      assert.equal(volumeCalls[0].vol5m, 200);
      assert.equal(volumeCalls[0].vol1h, 200);
      assert.equal(volumeCalls[0].source, 'pumpfun-pre-migration');
      assert.equal(capture.getStatus().totalVolumeBuckets, 1);
    } finally {
      tokenMarketBucket1m.upsertSnapshotBucket = originalMarket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalVolume;
      solPrice.getPrice = originalSolPrice;
    }
  });

  it('normalizes capture options with bounded defaults', () => {
    const options = capture.__private.resolveOptions({
      enabled: true,
      maxTracked: 999999,
      trackTtlMs: 1,
    });

    assert.equal(options.enabled, true);
    assert.equal(options.maxTracked, 2000);
    assert.equal(options.trackTtlMs, 60000);
  });
});
