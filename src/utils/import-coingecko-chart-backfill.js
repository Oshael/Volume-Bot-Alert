#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../models/db');
const { isValidAddress } = require('../models/user-token');
const coingeckoOnchain = require('../services/coingecko-onchain');
const chartBackfillPlan = require('../services/coingecko-chart-backfill-plan');
const chartBackfillWrite = require('../services/coingecko-chart-backfill-write');
const chartBackfillRestore = require('../services/coingecko-chart-backfill-restore');
const chartBackfillSafeWrite = require('../services/coingecko-chart-backfill-safe-write');
const tokenMarketBuckets = require('../models/token-market-bucket-1m');

const DEFAULT_MODE = 'dry-run';
const DEFAULT_BACKUP_DIR = path.resolve(process.cwd(), 'data/coingecko/backups');
const STRING_ARGS = new Map([
  ['--token', 'tokenAddress'],
  ['--pool', 'poolAddress'],
  ['--network', 'network'],
  ['--mode', 'mode'],
  ['--granularity', 'granularity'],
  ['--mcap-multiplier', 'mcapMultiplier'],
  ['--backup-dir', 'backupDir'],
  ['--restore-backup', 'restoreBackup'],
  ['--from', 'from'],
  ['--to', 'to'],
]);
const INTEGER_ARGS = new Map([
  ['--days', 'days'],
  ['--aggregate', 'aggregate'],
  ['--limit', 'limit'],
  ['--delay-ms', 'delayMs'],
]);
const BOOLEAN_ARGS = new Map([
  ['--no-empty-intervals', ['includeEmptyIntervals', false]],
  ['--confirm-replace', ['confirmReplace', true]],
  ['--confirm-restore', ['confirmRestore', true]],
  ['--confirm-fill', ['confirmFill', true]],
  ['--confirm-replace-bad', ['confirmReplaceBad', true]],
  ['--help', ['help', true]],
  ['-h', ['help', true]],
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    tokenAddress: '',
    poolAddress: '',
    network: 'solana',
    mode: DEFAULT_MODE,
    days: 31,
    aggregate: 5,
    limit: 1000,
    delayMs: 800,
    includeEmptyIntervals: true,
    mcapMultiplier: null,
    from: '',
    to: '',
    backupDir: DEFAULT_BACKUP_DIR,
    confirmReplace: false,
    confirmRestore: false,
    confirmFill: false,
    confirmReplaceBad: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (!arg.startsWith('--') && !options.tokenAddress) {
      options.tokenAddress = arg;
      continue;
    }

    if (STRING_ARGS.has(arg)) {
      const key = STRING_ARGS.get(arg);
      options[key] = ['backupDir', 'restoreBackup'].includes(key)
        ? path.resolve(next || (key === 'backupDir' ? DEFAULT_BACKUP_DIR : ''))
        : (next || '');
      index += 1;
      continue;
    }

    if (INTEGER_ARGS.has(arg)) {
      options[INTEGER_ARGS.get(arg)] = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    const booleanArg = BOOLEAN_ARGS.get(arg);
    if (!booleanArg) throw new Error(`Unknown argument: ${arg}`);
    options[booleanArg[0]] = booleanArg[1];
  }

  if (options.granularity) {
    options.aggregate = chartBackfillPlan.parseGranularityMinutes(options.granularity, options.aggregate);
  }
  options.mode = String(options.mode || DEFAULT_MODE).trim().toLowerCase();

  return options;
}

function usage() {
  return [
    'Usage:',
    '  node src/utils/import-coingecko-chart-backfill.js --token <tokenAddress> --mode dry-run [options]',
    '  node src/utils/import-coingecko-chart-backfill.js --token <tokenAddress> --mode replace-chart --confirm-replace [options]',
    '  node src/utils/import-coingecko-chart-backfill.js --token <tokenAddress> --mode fill-missing --confirm-fill [options]',
    '  node src/utils/import-coingecko-chart-backfill.js --token <tokenAddress> --mode replace-bad-buckets --confirm-replace-bad [options]',
    '  node src/utils/import-coingecko-chart-backfill.js --token <tokenAddress> --restore-backup <file> --confirm-restore',
    '',
    'Env:',
    '  COINGECKO_DEMO_API_KEY=<demo key>',
    '',
    'Options:',
    '  --pool <address>              Override local token_catalog.last_pair_address',
    '  --days 31                    History window to request',
    '  --from <ISO date/time>        Exact history window start; YYYY-MM-DD is UTC start of day',
    '  --to <ISO date/time>          Exact history window end; YYYY-MM-DD is UTC end of day',
    '  --granularity 5m             CoinGecko minute aggregation; 5m writes to aggregate storage',
    '  --mcap-multiplier <number>   Manual market-cap multiplier fallback',
    '  --backup-dir <path>          Default: data/coingecko/backups',
    '  --confirm-replace            Required with --mode replace-chart',
    '  --confirm-restore            Required to restore a validated backup',
    '  --confirm-fill               Required with --mode fill-missing',
    '  --confirm-replace-bad        Required with --mode replace-bad-buckets',
    '  --network solana             CoinGecko onchain network',
    '  --limit 1000                 Page size',
    '  --delay-ms 800               Delay between paginated calls',
    '  --no-empty-intervals         Ask CoinGecko not to fill intervals',
  ].join('\n');
}

async function resolveLocalToken(tokenAddress) {
  const { rows } = await db.query(
    `SELECT
       address,
       symbol,
       name,
       last_pair_address,
       last_pair_url,
       last_mcap,
       last_price,
       last_seen_at,
       last_evaluated_at
     FROM token_catalog
     WHERE chain = 'solana'
       AND address = $1
     LIMIT 1`,
    [tokenAddress]
  );
  return rows[0] || null;
}

function resolvePoolAddress(options, catalogRow) {
  const explicit = String(options.poolAddress || '').trim();
  if (explicit) return explicit;
  return String(catalogRow?.last_pair_address || '').trim();
}

async function countExistingRows(tokenAddress, fromBucketAt, toBucketAt) {
  if (!fromBucketAt || !toBucketAt) {
    return {
      tokenMarketBuckets1mRows: 0,
      tokenMarketBucketsAggRows: 0,
      tokenMarketBucketsAggRowsByGranularity: {},
    };
  }

  const [baseResult, aggResult] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS row_count
       FROM token_market_buckets_1m
       WHERE chain = 'solana'
         AND token_address = $1
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts <= $3::timestamptz`,
      [tokenAddress, fromBucketAt, toBucketAt]
    ),
    db.query(
      `SELECT granularity_minutes, COUNT(*)::int AS row_count
       FROM token_market_buckets_agg
       WHERE chain = 'solana'
         AND token_address = $1
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts <= $3::timestamptz
       GROUP BY granularity_minutes
       ORDER BY granularity_minutes ASC`,
      [tokenAddress, fromBucketAt, toBucketAt]
    ),
  ]);

  const byGranularity = {};
  let aggregateTotal = 0;
  for (const row of aggResult.rows || []) {
    const granularity = String(row.granularity_minutes);
    const count = Number(row.row_count) || 0;
    byGranularity[granularity] = count;
    aggregateTotal += count;
  }

  return {
    tokenMarketBuckets1mRows: Number(baseResult.rows?.[0]?.row_count) || 0,
    tokenMarketBucketsAggRows: aggregateTotal,
    tokenMarketBucketsAggRowsByGranularity: byGranularity,
  };
}

async function buildPlan(options) {
  const tokenAddress = String(options.tokenAddress || '').trim();
  if (!isValidAddress(tokenAddress)) {
    throw new Error('A valid --token address is required.');
  }
  if (![1, 5].includes(Number(options.aggregate))) {
    throw new Error('CoinGecko replace supports only 1m or 5m source candles.');
  }

  const catalogRow = await resolveLocalToken(tokenAddress);
  const poolAddress = resolvePoolAddress(options, catalogRow);
  if (!isValidAddress(poolAddress)) {
    throw new Error('Pool address was not found locally. Pass --pool <poolAddress>.');
  }

  const result = await coingeckoOnchain.fetchPoolOhlcv({
    poolAddress,
    network: options.network,
    days: options.days,
    from: options.from,
    to: options.to,
    aggregate: options.aggregate,
    limit: options.limit,
    delayMs: options.delayMs,
    includeEmptyIntervals: options.includeEmptyIntervals,
  });
  const firstBucketAt = result.candles[0]?.bucketTs || null;
  const latestBucketAt = result.candles.at(-1)?.bucketTs || null;
  const existing = await countExistingRows(tokenAddress, firstBucketAt, latestBucketAt);

  const plan = chartBackfillPlan.buildDryRunPlan({
    tokenAddress,
    poolAddress,
    catalogRow,
    result,
    existing,
    days: options.days,
    from: options.from,
    to: options.to,
    network: options.network,
    granularityMinutes: options.aggregate,
    mcapMultiplier: options.mcapMultiplier,
  });
  return { plan, result };
}

function buildBackfillBucketsFromPlan(plan, result) {
  return chartBackfillPlan.buildBackfillBuckets(result.candles, {
    tokenAddress: plan.token.address,
    poolAddress: plan.poolAddress,
    granularityMinutes: plan.request.granularityMinutes,
    mcapMultiplier: plan.mcapMultiplier.value,
  });
}

async function validateChartReads(plan, model = tokenMarketBuckets) {
  const tokenAddress = plan.token.address;
  const sourceGranularity = plan.request.granularityMinutes;
  const granularities = [1, 5, 15, 30, 60, 240, 1440]
    .filter((granularity) => granularity >= sourceGranularity);
  const compactRows = await model.listSparklineByAddresses([tokenAddress], {
    hours: 30 * 24,
    points: 336,
    granularityMinutes: sourceGranularity,
    allowOneMinuteFallback: false,
    disableCache: true,
  });
  const expanded = {};
  for (const granularityMinutes of granularities) {
    const row = await model.listExpandedSparklineByAddress(tokenAddress, {
      granularityMinutes,
      allowOneMinuteFallback: false,
      disableCache: true,
    });
    expanded[String(granularityMinutes)] = {
      bucketCount: Number(row?.bucketCount) || 0,
      candleCount: Array.isArray(row?.candles) ? row.candles.length : 0,
      firstBucketAt: row?.firstBucketAt || null,
      latestBucketAt: row?.latestBucketAt || null,
    };
  }
  return {
    ok: compactRows.length > 0 && Object.values(expanded).every((row) => row.candleCount > 0),
    cache: {
      invalidation: 'server_ttl',
      maxStaleMs: 30000,
    },
    compact: {
      rows: compactRows.length,
      points: Array.isArray(compactRows[0]?.series) ? compactRows[0].series.length : 0,
    },
    expanded,
  };
}

async function runRestore(options) {
  const tokenAddress = String(options.tokenAddress || '').trim();
  if (!isValidAddress(tokenAddress)) {
    throw new Error('A valid --token address is required for restore.');
  }
  const backup = await chartBackfillRestore.loadBackupFile(options.restoreBackup, {
    expectedTokenAddress: tokenAddress,
  });
  const restorePlan = {
    mode: 'restore-backup',
    writes: false,
    tokenAddress,
    backupPath: options.restoreBackup,
    granularityMinutes: backup.granularityMinutes,
    range: backup.range,
    rows: {
      tokenMarketBuckets1m: backup.baseRows.length,
      tokenMarketBucketsAgg: backup.aggregateRows.length,
    },
  };
  if (!options.confirmRestore) {
    console.log(JSON.stringify(restorePlan, null, 2));
    throw new Error('Refusing to restore without --confirm-restore. Review the restore plan above.');
  }
  const result = await chartBackfillRestore.executeRestore({ db, backup });
  const validationPlan = {
    token: { address: tokenAddress },
    request: { granularityMinutes: backup.granularityMinutes },
  };
  let validation;
  try {
    validation = await validateChartReads(validationPlan);
  } catch (error) {
    validation = { ok: false, error: error.message };
  }
  console.log(JSON.stringify({ plan: restorePlan, result, validation }, null, 2));
}

function assertModeConfirmed(options, plan) {
  const confirmations = {
    'replace-chart': [options.confirmReplace, '--confirm-replace'],
    'fill-missing': [options.confirmFill, '--confirm-fill'],
    'replace-bad-buckets': [options.confirmReplaceBad, '--confirm-replace-bad'],
  };
  const confirmation = confirmations[options.mode];
  if (!confirmation) throw new Error(`Unsupported mode: ${options.mode}`);
  if (!confirmation[0]) {
    console.log(JSON.stringify(plan, null, 2));
    throw new Error(`Refusing to write without ${confirmation[1]}. Review the dry-run plan above.`);
  }
}

async function executeWriteMode(options, plan, buckets) {
  const common = { db, plan, buckets, backupDir: options.backupDir };
  if (options.mode === 'replace-chart') {
    return chartBackfillWrite.executeReplaceChart(common);
  }
  if (options.mode === 'fill-missing') {
    return chartBackfillSafeWrite.executeFillMissing(common);
  }
  return chartBackfillSafeWrite.executeReplaceBadBuckets(common);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.restoreBackup) {
    await runRestore(options);
    return;
  }

  const built = await buildPlan(options);
  let plan = built.plan;
  const result = built.result;
  if (options.mode === 'dry-run') {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const buckets = buildBackfillBucketsFromPlan(plan, result);
  if (['fill-missing', 'replace-bad-buckets'].includes(options.mode)) {
    plan = {
      ...plan,
      selectiveImpact: await chartBackfillSafeWrite.inspectSelectiveWrite({
        db,
        plan,
        buckets,
        mode: options.mode,
      }),
    };
  }
  assertModeConfirmed(options, plan);

  const writeResult = await executeWriteMode(options, plan, buckets);
  let validation;
  try {
    validation = await validateChartReads(plan);
  } catch (error) {
    validation = { ok: false, error: error.message };
  }
  console.log(JSON.stringify({ plan, result: writeResult, validation }, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`[import-coingecko-chart-backfill] ${error.message}`);
      if (error.details?.body) {
        console.error(error.details.body);
      }
      process.exitCode = 1;
    })
    .finally(() => {
      void db.pool.end();
    });
}

module.exports = {
  buildBackfillBucketsFromPlan,
  buildPlan,
  countExistingRows,
  executeWriteMode,
  parseArgs,
  assertModeConfirmed,
  runRestore,
  validateChartReads,
};
