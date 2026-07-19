const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createCatalogMarketHistoryService,
  __private,
} = require('../src/services/catalog-market-history');

const SOLANA = 'So11111111111111111111111111111111111111112';
const ROBINHOOD = '0xabcdef0123456789abcdef0123456789abcdef01';
const NOW = new Date('2026-07-15T12:00:00.000Z');

describe('chain-aware catalog market history service', () => {
  it('does not advertise retained 1m data from an older permanent aggregate', () => {
    const item = __private.buildRobinhoodItem({
      chain: 'robinhood', address: ROBINHOOD, resolution: 'minute',
      minuteStartsAt: '2026-07-15T12:00:00.000Z', candles: [{
        bucketTs: '2026-07-15T11:00:00.000Z', sourceGranularityMinutes: 1,
        closeFdvUsd: 100,
      }],
    });

    assert.equal(item.oneMinuteAvailable, false);
  });

  it('keeps address-only requests on the legacy Solana reader', async () => {
    const calls = [];
    const service = createCatalogMarketHistoryService({
      now: () => NOW,
      solanaReader: {
        async listExpandedSparklineByAddress(address, options) {
          calls.push({ address, options });
          return { address, granularityMinutes: 30, series: [100] };
        },
      },
    });
    const result = await service.getExpandedSparkline({
      address: SOLANA, points: 720, granularityMinutes: 30,
    });

    assert.deepEqual(calls, [{
      address: SOLANA,
      options: { points: 720, granularityMinutes: 30, allowOneMinuteFallback: false },
    }]);
    assert.equal(result.chain, 'solana');
    assert.equal(result.item.valuationType, 'market-cap');
  });

  it('maps Robinhood history to explicit FDV candles and preserves gaps', async () => {
    const calls = [];
    const service = createCatalogMarketHistoryService({
      now: () => NOW,
      robinhoodReader: {
        async getHistory(input) {
          calls.push(input);
          return {
            chain: 'robinhood', address: ROBINHOOD, resolution: 'mixed',
            minuteStartsAt: '2026-07-01T12:00:00.000Z', truncated: false,
            firstBucketAt: '2026-07-15T11:00:00.000Z',
            latestBucketAt: '2026-07-15T11:10:00.000Z',
            candles: [0, 10].map((minute) => ({
              bucketTs: `2026-07-15T11:${String(minute).padStart(2, '0')}:00.000Z`,
              granularityMinutes: 5, sourceGranularityMinutes: minute ? 1 : 60,
              valuationType: 'fdv', openFdvUsd: 100, highFdvUsd: 120,
              lowFdvUsd: 90, closeFdvUsd: 110 + minute,
              openPriceUsd: 1, highPriceUsd: 1.2, lowPriceUsd: 0.9,
              closePriceUsd: 1.1, activity: { volumeUsd: 25, swaps: 1 },
            })),
          };
        },
      },
    });
    const result = await service.getExpandedSparkline({
      chain: 'robinhood', address: ROBINHOOD.toUpperCase(), points: 120,
      granularityMinutes: 5,
    });

    assert.equal(calls[0].address, ROBINHOOD);
    assert.equal(calls[0].startAt.toISOString(), '2026-07-15T02:00:00.000Z');
    assert.equal(result.valuationType, 'fdv');
    assert.equal(result.item.candles[0].closeFdvUsd, 110);
    assert.deepEqual(result.item.series, [110, 120]);
    assert.equal(result.item.oneMinuteAvailable, true);
    assert.equal(result.item.candles.some((item) => item.bucketTs.includes('11:05')), false);
    assert.equal('closeMcap' in result.item.candles[0], false);
  });

  it('batches each chain once and restores the requested identity order', async () => {
    const calls = { solana: [], robinhood: [] };
    const history = {
      chain: 'robinhood', address: ROBINHOOD, resolution: 'minute',
      minuteStartsAt: '2026-07-01T12:00:00.000Z', truncated: false,
      firstBucketAt: null, latestBucketAt: null, candles: [],
    };
    const service = createCatalogMarketHistoryService({
      now: () => NOW,
      solanaReader: { async listSparklineByAddresses(addresses, options) {
        calls.solana.push({ addresses, options });
        return [{ address: SOLANA, series: [10] }];
      } },
      robinhoodReader: { async getHistories(input) {
        calls.robinhood.push(input);
        return [history];
      } },
    });

    const result = await service.getSparklineBatch({
      identities: [
        { chain: 'robinhood', address: ROBINHOOD.toUpperCase() },
        { chain: 'solana', address: SOLANA },
      ],
      hours: 24, points: 48, granularityMinutes: 30,
    });

    assert.equal(calls.solana.length, 1);
    assert.deepEqual(calls.solana[0].addresses, [SOLANA]);
    assert.equal(calls.robinhood.length, 1);
    assert.deepEqual(calls.robinhood[0].addresses, [ROBINHOOD]);
    assert.equal(calls.robinhood[0].startAt.toISOString(), '2026-07-14T12:00:00.000Z');
    assert.deepEqual(result.items.map((item) => item.chain), ['robinhood', 'solana']);
    assert.deepEqual(result.chains, ['robinhood', 'solana']);
  });

  it('publishes deterministic per-chain metrics after a mixed batch', async () => {
    const metrics = [];
    const service = createCatalogMarketHistoryService({
      now: () => NOW,
      solanaReader: { async listSparklineByAddresses(addresses, options) {
        options.onMetrics({ source: 'aggregate', rows: 2, aggregateRows: 2, queryDurationMs: 3 });
        return [{ address: addresses[0], series: [10] }];
      } },
      robinhoodReader: { async getHistories(input) {
        input.onMetrics({
          source: 'fallback', rows: 1, fallbackRows: 1,
          fallbackAddresses: 1, queryDurationMs: 5,
        });
        return [{
          chain: 'robinhood', address: ROBINHOOD, resolution: 'minute',
          minuteStartsAt: NOW.toISOString(), candles: [],
        }];
      } },
    });

    await service.getSparklineBatch({
      identities: [
        { chain: 'solana', address: SOLANA },
        { chain: 'robinhood', address: ROBINHOOD },
      ],
      onMetrics(value) { metrics.push(value); },
    });

    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].source, 'solana:aggregate,robinhood:fallback');
    assert.equal(metrics[0].rows, 3);
    assert.equal(metrics[0].fallbackAddresses, 1);
    assert.equal(metrics[0].queryDurationMs, 5);
    assert.deepEqual(Object.keys(metrics[0].chains), ['solana', 'robinhood']);
  });

  it('rejects future EVM chains instead of falling back to Solana', async () => {
    const service = createCatalogMarketHistoryService();
    await assert.rejects(
      service.getExpandedSparkline({ chain: 'base', address: ROBINHOOD }),
      /unavailable for base/,
    );
  });
});
