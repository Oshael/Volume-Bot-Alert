#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../models/db');
const { isValidAddress } = require('../models/user-token');
const importer = require('./import-coingecko-chart-backfill');
const safeWrite = require('../services/coingecko-chart-backfill-safe-write');

const LOOKBACK_HOURS = 12;
const MINUTE_MS = 60 * 1000;
const DEFAULT_TOKEN_DELAY_MS = 800;
// Same floor the dashboard uses to decide which tokens count as monitored.
const MIN_MARKET_CAP = 30000;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    confirmFill: false,
    delayMs: DEFAULT_TOKEN_DELAY_MS,
    limit: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm-fill') options.confirmFill = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--delay-ms' || arg === '--limit') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isInteger(value) || value < (arg === '--limit' ? 1 : 0)) {
        throw new Error(`${arg} requires a valid integer`);
      }
      options[arg === '--limit' ? 'limit' : 'delayMs'] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node src/utils/recover-coingecko-active-gaps.js [--confirm-fill] [options]',
    '',
    'Audits the last 12 completed hours of 1m CoinGecko candles for every monitored',
    'Solana token in descending market-cap order. Monitored means eligible for',
    `monitoring with market cap >= ${MIN_MARKET_CAP}, excluding dormant and blocked.`,
    'Without --confirm-fill it only prints the report.',
    '',
    'Options:',
    '  --confirm-fill   Insert missing 1m buckets token by token while auditing',
    '  --delay-ms 800   Delay between CoinGecko token requests',
    '  --limit <count>  Optional highest-market-cap token limit',
  ].join('\n');
}

function resolveWindow(now = new Date()) {
  const currentMinuteMs = Math.floor(new Date(now).getTime() / MINUTE_MS) * MINUTE_MS;
  const toMs = currentMinuteMs - MINUTE_MS;
  return {
    from: new Date(toMs - ((LOOKBACK_HOURS * 60 - 1) * MINUTE_MS)).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

function resolveMcapMultiplier(token) {
  const marketCap = Number(token.last_mcap);
  const price = Number(token.last_price);
  return marketCap > 0 && price > 0 ? marketCap / price : null;
}

async function listActiveTokens(options = {}, database = db) {
  const params = [MIN_MARKET_CAP];
  const limitSql = options.limit == null ? '' : `\n     LIMIT $${params.push(options.limit)}::int`;
  const result = await database.query(
    `SELECT
       tc.address,
       tc.symbol,
       tc.name,
       tc.last_pair_address,
       tc.last_mcap,
       tc.last_price,
       tc.monitor_priority
     FROM token_catalog tc
     WHERE tc.chain = 'solana'
       AND tc.eligible_for_monitoring = TRUE
       AND COALESCE(tc.last_mcap, 0) >= $1::numeric
       AND tc.is_active_monitor_candidate = TRUE
       AND tc.monitor_priority IN ('high', 'normal', 'low')
       AND NOT EXISTS (
         SELECT 1
         FROM admin_blocked_tokens blocked
         WHERE blocked.chain = tc.chain
           AND blocked.address = tc.address
       )
     ORDER BY tc.last_mcap DESC NULLS LAST, tc.address ASC${limitSql}`,
    params
  );
  return result.rows || [];
}

async function prepareToken(token, window, options, dependencies) {
  const poolAddress = String(token.last_pair_address || '').trim();
  const multiplier = resolveMcapMultiplier(token);
  if (!isValidAddress(poolAddress)) throw new Error('valid CoinGecko pool is missing');
  if (!(multiplier > 0)) throw new Error('catalog market-cap/price anchor is missing');

  const built = await dependencies.importer.buildPlan({
    tokenAddress: token.address,
    poolAddress,
    mode: 'fill-missing',
    aggregate: 1,
    days: 1,
    from: window.from,
    to: window.to,
    limit: 1000,
    delayMs: options.delayMs,
    includeEmptyIntervals: true,
    mcapMultiplier: multiplier,
  });
  const buckets = dependencies.importer.buildBackfillBucketsFromPlan(built.plan, built.result);
  const selectiveImpact = await dependencies.safeWrite.inspectSelectiveWrite({
    db: dependencies.db,
    plan: built.plan,
    buckets,
    mode: 'fill-missing',
  });
  return {
    plan: { ...built.plan, selectiveImpact },
    buckets,
    report: {
      address: token.address,
      symbol: token.symbol || null,
      marketCap: Number(token.last_mcap) || null,
      priority: token.monitor_priority,
      poolAddress,
      coingeckoCandles: built.plan.coingecko.candles,
      coingeckoSourceGaps: built.plan.coingecko.gaps,
      existingBuckets: selectiveImpact.matchingExistingRows,
      missingBuckets: selectiveImpact.wouldWrite,
      missingRuns: selectiveImpact.runs,
      status: selectiveImpact.wouldWrite > 0 ? 'ready' : 'complete',
    },
  };
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function recoverToken(token, window, options, dependencies, prepare = prepareToken) {
  let item;
  try {
    item = await prepare(token, window, options, dependencies);
  } catch (error) {
    return {
      report: {
        address: token.address,
        symbol: token.symbol || null,
        marketCap: Number(token.last_mcap) || null,
        status: 'blocked',
        error: error.message,
      },
      restitution: null,
    };
  }

  if (!options.confirmFill || item.report.missingBuckets <= 0) {
    return { report: item.report, restitution: null };
  }

  try {
    const result = await dependencies.safeWrite.executeFillMissing({
      db: dependencies.db,
      plan: item.plan,
      buckets: item.buckets,
    });
    return {
      report: { ...item.report, status: 'filled' },
      restitution: { address: item.report.address, status: 'filled', ...result },
    };
  } catch (error) {
    return {
      report: { ...item.report, status: 'write-failed', error: error.message },
      restitution: { address: item.report.address, status: 'failed', error: error.message },
    };
  }
}

async function runRecovery(options = {}, injected = {}) {
  const dependencies = {
    db: injected.db || db,
    importer: injected.importer || importer,
    safeWrite: injected.safeWrite || safeWrite,
    logger: injected.logger || console,
    now: injected.now || (() => new Date()),
    sleep: injected.sleep || sleep,
  };
  const window = resolveWindow(dependencies.now());
  const tokens = await (injected.listActiveTokens || listActiveTokens)(options, dependencies.db);
  const prepare = injected.prepareToken || prepareToken;

  const tokenReports = [];
  const results = [];
  for (const [index, token] of tokens.entries()) {
    const outcome = await recoverToken(token, window, options, dependencies, prepare);
    tokenReports.push(outcome.report);
    if (outcome.restitution) results.push(outcome.restitution);
    // Progress must be visible while running; the consolidated report only lands at the end.
    dependencies.logger.log(JSON.stringify({ token: outcome.report }));
    if (index < tokens.length - 1) await dependencies.sleep(options.delayMs);
  }

  const report = {
    generatedAt: dependencies.now().toISOString(),
    writes: Boolean(options.confirmFill),
    window: { ...window, hours: LOOKBACK_HOURS, granularityMinutes: 1 },
    tokenCount: tokens.length,
    recoverableTokens: tokenReports.filter((item) => Number(item.missingBuckets) > 0).length,
    missingBuckets: tokenReports.reduce((sum, item) => sum + (Number(item.missingBuckets) || 0), 0),
    tokens: tokenReports,
  };
  dependencies.logger.log(JSON.stringify({ report }, null, 2));
  if (!options.confirmFill) return { report, restitution: null };

  const restitution = {
    writes: true,
    filledTokens: results.filter((item) => item.status === 'filled').length,
    failedTokens: results.filter((item) => item.status === 'failed').length,
    insertedBuckets: results.reduce((sum, item) => sum + (Number(item.inserted) || 0), 0),
    results,
  };
  dependencies.logger.log(JSON.stringify({ restitution }, null, 2));
  return { report, restitution };
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runRecovery(options);
  const blocked = result.report.tokens.some((token) => token.status === 'blocked');
  if (blocked || result.restitution?.failedTokens > 0) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`[recover-coingecko-active-gaps] ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => {
      void db.pool.end();
    });
}

module.exports = {
  LOOKBACK_HOURS,
  MIN_MARKET_CAP,
  listActiveTokens,
  parseArgs,
  prepareToken,
  recoverToken,
  resolveMcapMultiplier,
  resolveWindow,
  runRecovery,
  usage,
};
