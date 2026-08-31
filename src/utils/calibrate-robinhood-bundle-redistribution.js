require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodBundleRedistributionCalibration,
} = require('../models/robinhood-bundle-redistribution-calibration');

const VALUE_ARGUMENTS = new Set([
  'page-size', 'max-pages', 'after-token', 'statement-timeout-ms', 'sample-limit',
]);

function integer(value, fallback, min, max, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match || !VALUE_ARGUMENTS.has(match[1]) || values[match[1]] != null) {
      throw new Error(`unknown or repeated argument: ${argument}`);
    }
    values[match[1]] = match[2];
  }
  return Object.freeze({
    pageSize: integer(values['page-size'], 50, 1, 100, '--page-size'),
    maxPages: integer(values['max-pages'], 1, 1, 5_000, '--max-pages'),
    afterToken: values['after-token'] || null,
    statementTimeoutMs: integer(
      values['statement-timeout-ms'], 120_000, 1_000, 900_000, '--statement-timeout-ms'
    ),
    sampleLimit: integer(values['sample-limit'], 20, 0, 100, '--sample-limit'),
  });
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function durationBucket(milliseconds) {
  const minutes = milliseconds / 60_000;
  if (minutes <= 1) return 'lte_1m';
  if (minutes <= 5) return 'gt_1m_lte_5m';
  if (minutes <= 30) return 'gt_5m_lte_30m';
  if (minutes <= 120) return 'gt_30m_lte_2h';
  if (minutes <= 1_440) return 'gt_2h_lte_24h';
  return 'gt_24h';
}

function recipientBucket(count) {
  if (count === 2) return 'two';
  if (count <= 5) return 'three_to_five';
  if (count <= 10) return 'six_to_ten';
  return 'eleven_plus';
}

function sellingBucket(cluster) {
  if (cluster.sellingRecipientCount === 0) return 'none';
  if (cluster.sellingRecipientCount === 1) return 'one';
  if (cluster.sellingRecipientCount === cluster.recipientCount) return 'all';
  return 'two_plus_partial';
}

function coverageBucket(value) {
  if (value == null) return 'unavailable';
  if (value < 100) return 'lt_1pct';
  if (value < 1_000) return 'gte_1pct_lt_10pct';
  if (value < 2_500) return 'gte_10pct_lt_25pct';
  if (value < 5_000) return 'gte_25pct_lt_50pct';
  if (value <= 10_000) return 'gte_50pct_lte_100pct';
  return 'gt_100pct';
}

function createAccumulator() {
  return {
    clusters: 0, tokens: new Set(), sources: new Set(), recipientLinks: 0,
    sellingRecipientLinks: 0, confirmedByTwoSellers: 0,
    launchToBuy: {}, buyToDistribution: {}, recipientCounts: {},
    sellingRecipients: {}, firstDistributionCoverage: {}, samples: [],
  };
}

function addCluster(result, cluster, sampleLimit) {
  result.clusters += 1;
  result.tokens.add(cluster.tokenAddress);
  result.sources.add(cluster.sourceWallet);
  result.recipientLinks += cluster.recipientCount;
  result.sellingRecipientLinks += cluster.sellingRecipientCount;
  if (cluster.sellingRecipientCount >= 2) result.confirmedByTwoSellers += 1;
  increment(result.launchToBuy, durationBucket(
    new Date(cluster.buyTime) - new Date(cluster.launchTime)
  ));
  increment(result.buyToDistribution, durationBucket(
    new Date(cluster.firstTransferTime) - new Date(cluster.buyTime)
  ));
  increment(result.recipientCounts, recipientBucket(cluster.recipientCount));
  increment(result.sellingRecipients, sellingBucket(cluster));
  increment(result.firstDistributionCoverage, coverageBucket(
    cluster.firstDistributionCoverageBps
  ));
  if (result.samples.length < sampleLimit) result.samples.push(cluster);
}

function reportAccumulator(result) {
  return {
    clusters: result.clusters, tokensWithClusters: result.tokens.size,
    distinctSources: result.sources.size, recipientLinks: result.recipientLinks,
    sellingRecipientLinks: result.sellingRecipientLinks,
    clustersConfirmedByTwoSellers: result.confirmedByTwoSellers,
    buckets: {
      launchToBuy: result.launchToBuy, buyToFirstDistribution: result.buyToDistribution,
      recipientCounts: result.recipientCounts, sellingRecipients: result.sellingRecipients,
      firstDistributionCoverageBps: result.firstDistributionCoverage,
    },
    samples: result.samples,
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const logger = deps.logger || console;
  const source = deps.source || createRobinhoodBundleRedistributionCalibration({
    database: deps.database || db, statementTimeoutMs: options.statementTimeoutMs,
  });
  const aggregate = createAccumulator();
  let afterToken = options.afterToken;
  let pages = 0;
  let tokensScanned = 0;
  let exhausted = false;
  while (pages < options.maxPages && !exhausted) {
    const page = await source.loadPage({ afterToken, pageSize: options.pageSize });
    pages += 1;
    tokensScanned += page.tokens.length;
    for (const cluster of page.clusters) addCluster(aggregate, cluster, options.sampleLimit);
    afterToken = page.nextToken;
    exhausted = page.exhausted;
    logger.error?.(`[BundleRedistributionCalibration] ${JSON.stringify({
      pages, tokensScanned, clusters: aggregate.clusters, nextToken: afterToken, exhausted,
    })}`);
  }
  const report = Object.freeze({
    mode: 'read-only', source: 'postgresql-permanent-first-transfer-edges+swaps',
    evidenceScope: 'lower_bound_first_transfer_strictly_after_buy_block',
    pageSize: options.pageSize, maxPages: options.maxPages, pages, tokensScanned,
    startAfterToken: options.afterToken, nextToken: afterToken, exhausted,
    ...reportAccumulator(aggregate),
  });
  logger.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('[BundleRedistributionCalibration] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  main, parseArgs,
  __private: { coverageBucket, durationBucket, recipientBucket, sellingBucket },
};
