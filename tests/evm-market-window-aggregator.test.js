const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_WINDOWS,
  createEvmMarketWindowAggregator,
  eventIdentity,
} = require('../src/services/evm-market-window-aggregator');

const TOKEN = '0x1111111111111111111111111111111111111111';

function observation(overrides = {}) {
  return {
    accepted: true,
    chain: 'robinhood',
    protocol: 'uniswap-v3',
    marketKey: 'robinhood:uniswap-v3:pool',
    tokenAddress: TOKEN,
    transactionHash: `0x${'aa'.repeat(32)}`,
    logIndex: '1',
    side: 'buy',
    timestampMs: 1_000_000,
    priceUsd: '100',
    volumeUsd: '0.1',
    ...overrides,
  };
}

describe('EVM market window aggregator', () => {
  it('defines all required rolling windows', () => {
    assert.deepEqual(DEFAULT_WINDOWS.map((window) => window.label), ['1m', '5m', '1h', '6h', '24h']);
  });

  it('aggregates buys, sells, swaps, txns, exact volume and rolling price change', () => {
    const aggregator = createEvmMarketWindowAggregator();
    aggregator.add(observation(), 1_010_000);
    aggregator.add(observation({
      logIndex: '2',
      side: 'sell',
      timestampMs: 1_005_000,
      priceUsd: '110',
      volumeUsd: '0.2',
    }), 1_010_000);
    const report = aggregator.snapshot(1_010_000).find((item) => item.window === '1m');

    assert.equal(report.swaps, 2);
    assert.equal(report.buys, 1);
    assert.equal(report.sells, 1);
    assert.equal(report.txns, 1);
    assert.equal(report.volumeUsd, '0.3');
    assert.deepEqual(report.exactVolumeUsd, { numerator: '3', denominator: '10' });
    assert.equal(report.firstPriceUsd, '100');
    assert.equal(report.latestPriceUsd, '110');
    assert.equal(report.priceChangePct, '10');
  });

  it('counts distinct transactions independently from swap logs', () => {
    const aggregator = createEvmMarketWindowAggregator();
    aggregator.add(observation(), 1_000_000);
    aggregator.add(observation({
      transactionHash: `0x${'bb'.repeat(32)}`,
      logIndex: '1',
      timestampMs: 1_000_001,
    }), 1_000_001);

    const report = aggregator.snapshot(1_000_001).find((item) => item.window === '1m');
    assert.equal(report.swaps, 2);
    assert.equal(report.txns, 2);
  });

  it('deduplicates by chain, transaction hash and log index', () => {
    const aggregator = createEvmMarketWindowAggregator();
    const event = observation();

    assert.equal(aggregator.add(event, 1_000_000).accepted, true);
    assert.deepEqual(aggregator.add({ ...event, volumeUsd: '999' }, 1_000_000), {
      accepted: false,
      reason: 'duplicate_log',
    });
    assert.equal(aggregator.snapshot(1_000_000).find((item) => item.window === '1m').volumeUsd, '0.1');
    assert.equal(eventIdentity(event), `robinhood:${event.transactionHash}:1`);
  });

  it('removes reverted observations so reorgs undo volume', () => {
    const aggregator = createEvmMarketWindowAggregator();
    const event = observation();
    aggregator.add(event, 1_000_000);

    assert.equal(aggregator.remove(event), true);
    assert.equal(aggregator.remove(event), false);
    assert.deepEqual(aggregator.snapshot(1_000_000), []);
  });

  it('expires events independently across 1m, 5m and 24h', () => {
    const aggregator = createEvmMarketWindowAggregator();
    const now = 100_000_000;
    aggregator.add(observation({ timestampMs: now - 30_000 }), now);
    aggregator.add(observation({
      transactionHash: `0x${'bb'.repeat(32)}`,
      timestampMs: now - 120_000,
    }), now);
    aggregator.add(observation({
      transactionHash: `0x${'cc'.repeat(32)}`,
      timestampMs: now - 7_200_000,
    }), now);

    const reports = aggregator.snapshot(now);
    assert.equal(reports.find((item) => item.window === '1m').swaps, 1);
    assert.equal(reports.find((item) => item.window === '5m').swaps, 2);
    assert.equal(reports.find((item) => item.window === '1h').swaps, 2);
    assert.equal(reports.find((item) => item.window === '24h').swaps, 3);
  });

  it('keeps protocols and markets in separate reports', () => {
    const aggregator = createEvmMarketWindowAggregator();
    aggregator.add(observation(), 1_000_000);
    aggregator.add(observation({
      protocol: 'uniswap-v4',
      marketKey: 'robinhood:uniswap-v4:pool-id',
      transactionHash: `0x${'bb'.repeat(32)}`,
    }), 1_000_000);

    const reports = aggregator.snapshot(1_000_000).filter((item) => item.window === '1m');
    assert.equal(reports.length, 2);
    assert.deepEqual(reports.map((item) => item.protocol).sort(), ['uniswap-v3', 'uniswap-v4']);
  });

  it('rejects invalid observations and invalid window configuration', () => {
    const aggregator = createEvmMarketWindowAggregator();

    assert.equal(aggregator.add({ accepted: false }).reason, 'invalid_observation');
    assert.equal(aggregator.add(observation({ timestampMs: null })).reason, 'invalid_observation');
    assert.equal(aggregator.add(observation({ priceUsd: '0' })).reason, 'invalid_observation');
    assert.throws(() => createEvmMarketWindowAggregator({ windows: [] }), /valid market window/);
  });
});
