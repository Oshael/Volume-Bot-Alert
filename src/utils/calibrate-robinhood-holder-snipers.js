require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodHolderLaunchSource,
} = require('../models/robinhood-holder-launch-source');
const {
  normalizeMinimumNotionalUsd,
} = require('../services/robinhood-holder-sniper-materializer');
const { formatDecimal, parseDecimal } = require('../services/evm-market-metrics');

const PREFIXES = Object.freeze({
  limit: '--limit=', concurrency: '--concurrency=', seed: '--seed=', thresholds: '--thresholds=',
});

function oneArgument(argv, prefix) {
  const values = argv.filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
  return values[0]?.slice(prefix.length) ?? null;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const unknown = argv.find((value) => !Object.values(PREFIXES).some((prefix) => (
    value.startsWith(prefix)
  )));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const seed = oneArgument(argv, PREFIXES.seed) ?? 'default';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(seed)) {
    throw new Error('--seed must be a lowercase identifier of at most 32 characters');
  }
  const rawThresholds = oneArgument(argv, PREFIXES.thresholds);
  const thresholds = rawThresholds == null || rawThresholds === '' ? []
    : [...new Set(rawThresholds.split(',').map((value) => (
      normalizeMinimumNotionalUsd(value).normalized
    )))];
  return Object.freeze({
    limit: boundedInteger(oneArgument(argv, PREFIXES.limit), 25, 1, 100, '--limit'),
    concurrency: boundedInteger(
      oneArgument(argv, PREFIXES.concurrency), 1, 1, 5, '--concurrency'
    ),
    seed,
    thresholds: Object.freeze(thresholds),
  });
}

function compareDecimal(left, right) {
  const leftScaled = left.value.numerator * right.value.denominator;
  const rightScaled = right.value.numerator * left.value.denominator;
  if (leftScaled === rightScaled) return 0;
  return leftScaled < rightScaled ? -1 : 1;
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return formatDecimal(sorted[index].value, 18);
}

function summarizeEvidence(results, thresholds) {
  const reasons = {};
  const notionals = [];
  let readyTokens = 0;
  let firstBuys = 0;
  let withinWindow = 0;
  let excluded = 0;
  let missingVolumeUsd = 0;
  for (const result of results) {
    if (!result.ready) {
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
      continue;
    }
    readyTokens += 1;
    const excludedAddresses = new Set(
      (result.exclusions || []).map(({ walletAddress }) => walletAddress)
    );
    for (const buy of result.firstBuys || []) {
      firstBuys += 1;
      if (buy.withinLaunchWindow !== true) continue;
      withinWindow += 1;
      if (excludedAddresses.has(buy.walletAddress)) {
        excluded += 1;
        continue;
      }
      if (buy.volumeUsd == null) {
        missingVolumeUsd += 1;
        continue;
      }
      notionals.push({ value: parseDecimal(buy.volumeUsd, 'volumeUsd') });
    }
  }
  notionals.sort(compareDecimal);
  const countsAtThreshold = Object.fromEntries(thresholds.map((threshold) => {
    const minimum = parseDecimal(threshold, 'threshold');
    const count = notionals.filter(({ value }) => (
      value.numerator * minimum.denominator >= minimum.numerator * value.denominator
    )).length;
    return [threshold, count];
  }));
  return Object.freeze({
    tokens: Object.freeze({
      selected: results.length, ready: readyTokens,
      unavailable: results.length - readyTokens,
      unavailableReasons: Object.freeze(Object.fromEntries(Object.entries(reasons).sort())),
    }),
    buys: Object.freeze({
      first: firstBuys, withinWindow, excluded, missingVolumeUsd,
      pricedCandidates: notionals.length,
    }),
    notionalUsd: Object.freeze({
      sampleSize: notionals.length, quantileMethod: 'nearest_rank',
      min: quantile(notionals, 0), p25: quantile(notionals, 0.25),
      p50: quantile(notionals, 0.50), p75: quantile(notionals, 0.75),
      p90: quantile(notionals, 0.90), p95: quantile(notionals, 0.95),
      max: quantile(notionals, 1), countsAtThreshold: Object.freeze(countsAtThreshold),
    }),
  });
}

async function mapConcurrent(values, concurrency, operation) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function runCalibration(runtime, options) {
  const { rows } = await runtime.database.query(
    `SELECT token_address FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND ledger_status = 'live'
        AND live_through_block IS NOT NULL AND live_through_hash IS NOT NULL
      ORDER BY MD5(token_address || $1) LIMIT $2::int`,
    [options.seed, options.limit]
  );
  const results = await mapConcurrent(
    rows.map(({ token_address: tokenAddress }) => tokenAddress),
    options.concurrency,
    (tokenAddress) => runtime.source.loadLaunchEvidence(tokenAddress)
  );
  return Object.freeze({
    mode: 'read-only', selection: Object.freeze({
      limit: options.limit, seed: options.seed, concurrency: options.concurrency,
    }),
    ...summarizeEvidence(results, options.thresholds),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const database = deps.database || db;
  const runtime = deps.runtime || Object.freeze({
    database,
    source: (deps.sourceFactory || createRobinhoodHolderLaunchSource)({ database }),
  });
  const report = await (deps.runCalibration || runCalibration)(runtime, options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood SNIPER calibration failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs, runCalibration, summarizeEvidence };
