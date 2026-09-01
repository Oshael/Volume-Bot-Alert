const assert = require('node:assert/strict');
const { it } = require('node:test');
const model = require('../src/models/robinhood-bundle-redistribution-calibration');
const command = require('../src/utils/calibrate-robinhood-bundle-redistribution');

function cluster(overrides = {}) {
  return {
    tokenAddress: `0x${'1'.repeat(40)}`, sourceWallet: `0x${'2'.repeat(40)}`,
    launchBlock: '10', launchTime: '2026-01-01T00:00:00.000Z',
    buyBlock: '20', buyTime: '2026-01-01T00:03:00.000Z',
    firstTransferBlock: '30', firstTransferTime: '2026-01-01T00:23:00.000Z',
    lastFirstTransferTime: '2026-01-01T00:24:00.000Z', recipientCount: 4,
    sellingRecipientCount: 2, firstRecipientSellTime: '2026-01-01T00:30:00.000Z',
    recipientSellCountsWithin: { lte_1m: 1, lte_5m: 2, lte_30m: 2, lte_2h: 2 },
    sourceBuyFdvUsd: 15000, recipientSellFdvWithin5mUsd: [5000, 60000],
    bundleConfirmationFdvUsd: 60000,
    firstDistributedAmountRaw: '250', boughtBeforeDistributionRaw: '1000',
    firstDistributionCoverageBps: 2500, ...overrides,
  };
}

it('defines a bounded lower-bound query without RPC or writes', () => {
  const sql = model.__private.CLUSTERS_SQL;
  assert.match(sql, /first_wallet_transfer_block > buy\.block_number/);
  assert.match(sql, /COUNT\(DISTINCT recipient_wallet\).*>= 2/s);
  assert.match(sql, /swap\.side = 'sell'/);
  assert.match(sql, /first_sell_time <= sell_after\.transfer_time \+ INTERVAL '5 minutes'/);
  assert.match(sql, /LEFT JOIN robinhood_swap_mc buy_mc/);
  assert.match(sql, /AS bundle_confirmation_fdv_usd/);
  assert.match(sql, /robinhood_infrastructure_registry/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
});

it('normalizes cumulative recipient sell-window counts', () => {
  const normalized = model.__private.row({
    token_address: `0x${'1'.repeat(40)}`, source_wallet: `0x${'2'.repeat(40)}`,
    launch_block: '10', launch_time: '2026-01-01T00:00:00.000Z',
    buy_block: '20', buy_time: '2026-01-01T00:03:00.000Z',
    first_transfer_block: '30', first_transfer_time: '2026-01-01T00:23:00.000Z',
    last_first_transfer_time: '2026-01-01T00:24:00.000Z', recipient_count: 4,
    selling_recipient_count: 3, first_recipient_sell_time: '2026-01-01T00:25:00.000Z',
    recipient_sells_within_1m: '1', recipient_sells_within_5m: '2',
    recipient_sells_within_30m: '3', recipient_sells_within_2h: '3',
    source_buy_fdv_usd: '15000',
    recipient_sell_fdv_within_5m_usd: ['5000', null, '60000'],
    bundle_confirmation_fdv_usd: '60000',
    first_distributed_amount_raw: '250', bought_before_distribution_raw: '1000',
  });
  assert.deepEqual(normalized.recipientSellCountsWithin, {
    lte_1m: 1, lte_5m: 2, lte_30m: 3, lte_2h: 3,
  });
  assert.equal(normalized.sourceBuyFdvUsd, 15000);
  assert.deepEqual(normalized.recipientSellFdvWithin5mUsd, [5000, null, 60000]);
  assert.equal(normalized.bundleConfirmationFdvUsd, 60000);
});

it('buckets durable FDV at explicit USD boundaries', () => {
  const { fdvBucket } = command.__private;
  const cases = [
    [null, 'unavailable'], [9999, 'lt_10k'], [10000, 'gte_10k_lt_25k'],
    [25000, 'gte_25k_lt_50k'], [50000, 'gte_50k_lt_100k'],
    [100000, 'gte_100k_lt_250k'], [250000, 'gte_250k_lt_500k'],
    [500000, 'gte_500k_lt_1m'], [1000000, 'gte_1m'],
  ];
  for (const [value, expected] of cases) assert.equal(fdvBucket(value), expected);
});

it('aggregates timing, recipient, seller and coverage calibration buckets', async () => {
  const messages = [];
  const report = await command.main([], {
    options: {
      pageSize: 2, maxPages: 2, afterToken: null,
      statementTimeoutMs: 1000, sampleLimit: 1,
    },
    source: {
      loadPage: async ({ afterToken }) => afterToken ? {
        tokens: [`0x${'3'.repeat(40)}`], clusters: [cluster({
          tokenAddress: `0x${'3'.repeat(40)}`, recipientCount: 2,
          sellingRecipientCount: 2, firstDistributionCoverageBps: 12000,
        })], nextToken: `0x${'3'.repeat(40)}`, exhausted: true,
      } : {
        tokens: [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`], clusters: [cluster()],
        nextToken: `0x${'2'.repeat(40)}`, exhausted: false,
      },
    },
    logger: { log: (value) => messages.push(value), error: () => {} },
  });
  assert.equal(report.mode, 'read-only');
  assert.equal(report.clusters, 2);
  assert.equal(report.clustersConfirmedByTwoSellers, 2);
  assert.equal(report.recipientSellsWithin.lte_1m, 2);
  assert.equal(report.recipientSellsWithin.lte_5m, 4);
  assert.equal(report.clustersWithAtLeastTwoRecipientSellsWithin.lte_5m, 2);
  assert.equal(report.fdvUsd.metric, 'fdv_usd');
  assert.equal(report.fdvUsd.source, 'robinhood_swap_mc');
  assert.deepEqual(report.fdvUsd.sourceFirstBuy, {
    population: 2, available: 2, unavailable: 0, buckets: { gte_10k_lt_25k: 2 },
  });
  assert.equal(report.fdvUsd.recipientSellsWithin5m.buckets.lt_10k, 2);
  assert.equal(report.fdvUsd.recipientSellsWithin5m.buckets.gte_50k_lt_100k, 2);
  assert.equal(
    report.fdvUsd.bundleConfirmationAtSecondRecipientSellWithin5m
      .buckets.gte_50k_lt_100k,
    2
  );
  assert.equal(report.buckets.launchToBuy.gt_1m_lte_5m, 2);
  assert.equal(report.buckets.buyToFirstDistribution.gt_5m_lte_30m, 2);
  assert.equal(report.buckets.firstDistributionSpan.lte_1m, 2);
  assert.equal(report.buckets.firstDistributionToFirstRecipientSell.gt_5m_lte_30m, 2);
  assert.equal(report.buckets.recipientCounts.three_to_five, 1);
  assert.equal(report.buckets.sellingRecipients.all, 1);
  assert.equal(report.buckets.firstDistributionCoverageBps.gt_100pct, 1);
  assert.equal(
    report.crossTabs.buyToFirstDistributionBySellerConfirmation.twoPlusSellers
      .gt_5m_lte_30m,
    2
  );
  assert.deepEqual(
    report.crossTabs.buyToFirstDistributionBySellerConfirmation.fewerThanTwoSellers,
    {}
  );
  assert.equal(report.concentration.topTokensByClusterCount.length, 2);
  assert.equal(report.concentration.topTokensByClusterCount[0].clusters, 1);
  assert.equal(report.concentration.topTokensByClusterCount[0].clusterShareBps, 5000);
  assert.equal(messages.length, 1);
});

it('omits sell latency when no recipient sold and separates seller confirmation', async () => {
  const report = await command.main([], {
    options: {
      pageSize: 1, maxPages: 1, afterToken: null,
      statementTimeoutMs: 1000, sampleLimit: 0,
    },
    source: {
      loadPage: async () => ({
        tokens: [`0x${'1'.repeat(40)}`],
        clusters: [cluster({
          sellingRecipientCount: 0, firstRecipientSellTime: null,
          recipientSellCountsWithin: { lte_1m: 0, lte_5m: 0, lte_30m: 0, lte_2h: 0 },
          recipientSellFdvWithin5mUsd: [], bundleConfirmationFdvUsd: null,
        })],
        nextToken: `0x${'1'.repeat(40)}`, exhausted: true,
      }),
    },
    logger: { log: () => {}, error: () => {} },
  });
  assert.deepEqual(report.buckets.firstDistributionToFirstRecipientSell, {});
  assert.equal(report.clustersWithAtLeastTwoRecipientSellsWithin.lte_2h, 0);
  assert.equal(
    report.fdvUsd.bundleConfirmationAtSecondRecipientSellWithin5m.population,
    0
  );
  assert.equal(
    report.crossTabs.buyToFirstDistributionBySellerConfirmation.fewerThanTwoSellers
      .gt_5m_lte_30m,
    1
  );
  assert.deepEqual(
    report.crossTabs.buyToFirstDistributionBySellerConfirmation.twoPlusSellers,
    {}
  );
});

it('rejects mutation-like flags and bounds page sizes', () => {
  assert.throws(() => command.parseArgs(['--apply']), /unknown or repeated/);
  assert.throws(() => command.parseArgs(['--page-size=101']), /between 1 and 100/);
});
