require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodHolderLaunchSource,
} = require('../models/robinhood-holder-launch-source');
const {
  createRobinhoodHolderSniperCalibrationSource,
} = require('../models/robinhood-holder-sniper-calibration-source');
const {
  createRobinhoodWalletTransferLiveSourceRepository,
} = require('../models/robinhood-wallet-transfer-live-source');
const {
  normalizeMinimumNotionalUsd,
} = require('../services/robinhood-holder-sniper-materializer');
const { formatDecimal, parseDecimal } = require('../services/evm-market-metrics');

const PREFIXES = Object.freeze({
  limit: '--limit=', concurrency: '--concurrency=', seed: '--seed=', thresholds: '--thresholds=',
});
const PRECISION_PROFILES = Object.freeze([
  Object.freeze({ name: 'sameBlockTop5', maxBlocks: 0n, maxBuyerRank: 5 }),
  Object.freeze({ name: 'within1BlockTop5', maxBlocks: 1n, maxBuyerRank: 5 }),
  Object.freeze({ name: 'within1BlockTop10', maxBlocks: 1n, maxBuyerRank: 10 }),
  Object.freeze({ name: 'within3BlocksTop10', maxBlocks: 3n, maxBuyerRank: 10 }),
]);

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

function atLeastNotional(candidate, threshold) {
  const minimum = parseDecimal(threshold, 'threshold');
  return candidate.value.numerator * minimum.denominator
    >= minimum.numerator * candidate.value.denominator;
}

function precisionCandidate(buy, value, tokenKey) {
  if (!/^\d+$/.test(String(buy.deltaBlocks ?? ''))
      || !Number.isSafeInteger(buy.buyerRank) || buy.buyerRank < 1) return null;
  return Object.freeze({
    walletAddress: buy.walletAddress,
    tokenKey,
    value,
    deltaBlocks: BigInt(buy.deltaBlocks),
    buyerRank: buy.buyerRank,
  });
}

function recurrenceSummary(candidates) {
  const tokenSets = new Map();
  for (const candidate of candidates) {
    const tokens = tokenSets.get(candidate.walletAddress) || new Set();
    tokens.add(candidate.tokenKey);
    tokenSets.set(candidate.walletAddress, tokens);
  }
  const tokenCounts = new Map([...tokenSets].map(([wallet, tokens]) => [wallet, tokens.size]));
  const countAt = (minimum) => ({
    wallets: [...tokenCounts.values()].filter((count) => count >= minimum).length,
    occurrences: candidates.filter((candidate) => (
      tokenCounts.get(candidate.walletAddress) >= minimum
    )).length,
  });
  return Object.freeze({
    occurrences: candidates.length,
    uniqueWallets: tokenSets.size,
    onAtLeast2Tokens: Object.freeze(countAt(2)),
    onAtLeast3Tokens: Object.freeze(countAt(3)),
  });
}

function summarizePrecision(candidates, thresholds, missingEvidence) {
  const profiles = Object.fromEntries(PRECISION_PROFILES.map((profile) => {
    const matches = candidates.filter((candidate) => (
      candidate.deltaBlocks <= profile.maxBlocks
        && candidate.buyerRank <= profile.maxBuyerRank
    ));
    return [profile.name, Object.freeze({
      rule: Object.freeze({
        maxBlocks: Number(profile.maxBlocks), maxBuyerRank: profile.maxBuyerRank,
      }),
      allPriced: recurrenceSummary(matches),
      atNotionalThreshold: Object.freeze(Object.fromEntries(thresholds.map((threshold) => (
        [threshold, recurrenceSummary(matches.filter((candidate) => (
          atLeastNotional(candidate, threshold)
        )))]
      )))),
    })];
  }));
  return Object.freeze({
    scope: 'selected_tokens',
    missingPositionEvidence: missingEvidence,
    profiles: Object.freeze(profiles),
  });
}

function strictCandidateWallets(results) {
  const wallets = new Set();
  for (const result of results) {
    if (!result.ready) continue;
    const excluded = new Set((result.exclusions || []).map(({ walletAddress }) => walletAddress));
    for (const buy of result.firstBuys || []) {
      if (buy.withinLaunchWindow === true && buy.volumeUsd != null
          && !excluded.has(buy.walletAddress) && /^\d+$/.test(String(buy.deltaBlocks ?? ''))
          && BigInt(buy.deltaBlocks) <= 1n && Number.isSafeInteger(buy.buyerRank)
          && buy.buyerRank >= 1 && buy.buyerRank <= 5) wallets.add(buy.walletAddress);
    }
  }
  return Object.freeze([...wallets].sort());
}

function summarizePopulationRecurrence(rows, candidateWallets, thresholds) {
  const ready = [];
  let missingPositionEvidence = 0;
  let missingVolumeUsd = 0;
  for (const row of rows) {
    if (!row.positionReady) {
      missingPositionEvidence += 1;
      continue;
    }
    if (row.volumeUsd == null) {
      missingVolumeUsd += 1;
      continue;
    }
    ready.push(Object.freeze({
      walletAddress: row.walletAddress,
      tokenKey: row.tokenAddress,
      value: parseDecimal(row.volumeUsd, 'population volumeUsd'),
    }));
  }
  return Object.freeze({
    scope: 'all_eligible_tokens_for_sample_candidates',
    rule: Object.freeze({ maxBlocks: 1, sampleCandidateMaxBuyerRank: 5 }),
    candidateWallets: candidateWallets.length,
    pricedOccurrences: ready.length,
    missingPositionEvidence,
    missingVolumeUsd,
    allPriced: recurrenceSummary(ready),
    atNotionalThreshold: Object.freeze(Object.fromEntries(thresholds.map((threshold) => (
      [threshold, recurrenceSummary(ready.filter((candidate) => (
        atLeastNotional(candidate, threshold)
      )))]
    )))),
  });
}

function summarizeEvidence(results, thresholds) {
  const reasons = {};
  const notionals = [];
  let readyTokens = 0;
  let firstBuys = 0;
  let withinWindow = 0;
  let excluded = 0;
  let missingVolumeUsd = 0;
  let missingPositionEvidence = 0;
  const precisionCandidates = [];
  for (const [resultIndex, result] of results.entries()) {
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
      const value = parseDecimal(buy.volumeUsd, 'volumeUsd');
      notionals.push({ value });
      const candidate = precisionCandidate(
        buy, value, result.tokenAddress || `sample-${resultIndex}`
      );
      if (candidate) precisionCandidates.push(candidate);
      else missingPositionEvidence += 1;
    }
  }
  notionals.sort(compareDecimal);
  const countsAtThreshold = Object.fromEntries(thresholds.map((threshold) => {
    const count = notionals.filter((candidate) => atLeastNotional(candidate, threshold)).length;
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
    precision: summarizePrecision(precisionCandidates, thresholds, missingPositionEvidence),
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
  const coverage = await runtime.coverageSource.loadBackfillFrontier();
  if (!coverage?.ready) {
    throw new Error(`historical swap coverage unavailable: ${coverage?.reason || 'unknown'}`);
  }
  const { rows } = await runtime.database.query(
    `WITH pool_origins AS (
       SELECT token_address, MIN(discovery_block) AS first_pool_block
         FROM robinhood_pool_registry WHERE chain = 'robinhood'
        GROUP BY token_address
     ), candidates AS (
       SELECT state.token_address,
              state.live_through_block,
              pool.first_pool_block
         FROM robinhood_holder_token_states state
         LEFT JOIN pool_origins pool ON pool.token_address = state.token_address
        WHERE state.chain = 'robinhood' AND state.ledger_status = 'live'
          AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
     ), stats AS (
       SELECT COUNT(*)::int AS live_tokens,
              COUNT(*) FILTER (WHERE first_pool_block IS NULL)::int AS pool_block_unavailable,
              COUNT(*) FILTER (WHERE first_pool_block < $1::bigint)::int AS before_coverage,
              COUNT(*) FILTER (WHERE first_pool_block >= $1::bigint
                AND first_pool_block > live_through_block)::int AS pool_ahead_of_holder,
              COUNT(*) FILTER (WHERE first_pool_block >= $1::bigint
                AND first_pool_block <= live_through_block
                AND live_through_block > $2::bigint)::int AS frontier_beyond_coverage,
              COUNT(*) FILTER (WHERE first_pool_block >= $1::bigint
                AND first_pool_block <= live_through_block
                AND live_through_block <= $2::bigint)::int AS eligible_tokens
         FROM candidates
     ), selected AS (
       SELECT token_address FROM candidates
        WHERE first_pool_block >= $1::bigint
          AND first_pool_block <= live_through_block AND live_through_block <= $2::bigint
        ORDER BY MD5(token_address || $3) LIMIT $4::int
     )
     SELECT selected.token_address, stats.* FROM stats LEFT JOIN selected ON true`,
    [
      coverage.historicalFromBlock, coverage.completeThroughBlock,
      options.seed, options.limit,
    ]
  );
  const population = rows[0] || {};
  const tokenAddresses = rows
    .map(({ token_address: tokenAddress }) => tokenAddress).filter(Boolean);
  const results = await mapConcurrent(
    tokenAddresses,
    options.concurrency,
    (tokenAddress) => runtime.source.loadLaunchEvidence(tokenAddress)
  );
  const candidateWallets = strictCandidateWallets(results);
  const populationRows = candidateWallets.length
    ? await runtime.recurrenceSource.loadPopulationRecurrence(candidateWallets, coverage)
    : [];
  return Object.freeze({
    mode: 'read-only', selection: Object.freeze({
      limit: options.limit, seed: options.seed, concurrency: options.concurrency,
    }),
    coverage: Object.freeze({
      historicalFromBlock: coverage.historicalFromBlock,
      completeThroughBlock: coverage.completeThroughBlock,
    }),
    population: Object.freeze({
      liveTokens: Number(population.live_tokens || 0),
      eligibleTokens: Number(population.eligible_tokens || 0),
      firstPoolBeforeCoverage: Number(population.before_coverage || 0),
      firstPoolAheadOfHolderFrontier: Number(population.pool_ahead_of_holder || 0),
      holderFrontierBeyondCoverage: Number(population.frontier_beyond_coverage || 0),
      firstPoolUnavailable: Number(population.pool_block_unavailable || 0),
    }),
    ...summarizeEvidence(results, options.thresholds),
    populationRecurrence: summarizePopulationRecurrence(
      populationRows, candidateWallets, options.thresholds
    ),
  });
}

function createRuntime(database, deps = {}) {
  const sourceRepository = deps.coverageSource
    || (deps.coverageSourceFactory
      || createRobinhoodWalletTransferLiveSourceRepository)({ database });
  let cachedCoverage;
  const coverageSource = Object.freeze({
    loadBackfillFrontier() {
      cachedCoverage ||= sourceRepository.loadBackfillFrontier();
      return cachedCoverage;
    },
  });
  return Object.freeze({
    database, coverageSource,
    source: (deps.sourceFactory || createRobinhoodHolderLaunchSource)({
      database, coverageSource,
    }),
    recurrenceSource: (deps.recurrenceSourceFactory
      || createRobinhoodHolderSniperCalibrationSource)({ database }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const database = deps.database || db;
  const runtime = deps.runtime || createRuntime(database, deps);
  const report = await (deps.runCalibration || runCalibration)(runtime, options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood SNIPER calibration failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  createRuntime, main, parseArgs, runCalibration,
  summarizeEvidence, summarizePopulationRecurrence,
};
