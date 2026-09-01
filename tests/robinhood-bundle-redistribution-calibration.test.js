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
    firstDistributedAmountRaw: '250', boughtBeforeDistributionRaw: '1000',
    firstDistributionCoverageBps: 2500, ...overrides,
  };
}

it('defines a bounded lower-bound query without RPC or writes', () => {
  const sql = model.__private.CLUSTERS_SQL;
  assert.match(sql, /first_wallet_transfer_block > buy\.block_number/);
  assert.match(sql, /COUNT\(DISTINCT recipient_wallet\).*>= 2/s);
  assert.match(sql, /swap\.side = 'sell'/);
  assert.match(sql, /robinhood_infrastructure_registry/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
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
        clusters: [cluster({ sellingRecipientCount: 0, firstRecipientSellTime: null })],
        nextToken: `0x${'1'.repeat(40)}`, exhausted: true,
      }),
    },
    logger: { log: () => {}, error: () => {} },
  });
  assert.deepEqual(report.buckets.firstDistributionToFirstRecipientSell, {});
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
