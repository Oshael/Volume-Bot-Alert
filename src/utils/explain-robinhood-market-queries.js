require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const aggregate = require('../models/robinhood-market-aggregate').__private;
const history = require('../models/robinhood-market-history-read').__private;
const auditor = require('./audit-robinhood-market-aggregate-coverage').__private;
const retention = require('../services/robinhood-retention-worker').__private;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 3;
const TOKEN_PATTERN = /^0x[0-9a-f]{40}$/;
const SAMPLE_TOKEN_SQL = `SELECT token_address
FROM robinhood_market_buckets_1m
WHERE chain = 'robinhood' AND bucket_ts >= $1 AND bucket_ts < $2
LIMIT 1`;
const TABLE_STATS_SQL = `SELECT relname,
  pg_relation_size(relid)::bigint AS table_bytes,
  pg_indexes_size(relid)::bigint AS index_bytes,
  pg_total_relation_size(relid)::bigint AS total_bytes,
  n_live_tup::bigint, n_dead_tup::bigint, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN (
  'robinhood_market_buckets_1m',
  'robinhood_market_buckets_1h',
  'robinhood_market_buckets_agg'
)
ORDER BY relname`;

function defaultBounds(now = new Date()) {
  const to = new Date(now);
  to.setUTCHours(0, 0, 0, 0);
  return {
    from: new Date(to.getTime() - DEFAULT_DAYS * DAY_MS).toISOString(),
    to: to.toISOString(),
  };
}

function readCliValues(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] == null) {
      throw new TypeError(`Invalid argument: ${argv[index]}`);
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

function boundedInteger(value, fallback, label, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseCliArgs(argv, now = new Date()) {
  const values = readCliValues(argv);
  const defaults = defaultBounds(now);
  const from = new Date(values.from || defaults.from);
  const to = new Date(values.to || defaults.to);
  const mode = String(values.mode || 'plan').toLowerCase();
  const token = values.token?.toLowerCase() || null;
  if (!['plan', 'analyze'].includes(mode)) throw new TypeError('mode must be plan or analyze');
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new TypeError('EXPLAIN bounds are invalid');
  }
  if (from.getTime() % DAY_MS || to.getTime() % DAY_MS) {
    throw new TypeError('EXPLAIN bounds must align to UTC days');
  }
  if (token && !TOKEN_PATTERN.test(token)) throw new TypeError('token is invalid');
  return {
    mode, token, from: from.toISOString(), to: to.toISOString(),
    tokenLimit: boundedInteger(values['token-limit'], 25, 'token-limit', 1, 250),
    statementTimeoutMs: boundedInteger(
      values['statement-timeout-ms'], 30_000, 'statement-timeout-ms', 1000, 120_000
    ),
    lockTimeoutMs: boundedInteger(
      values['lock-timeout-ms'], 1000, 'lock-timeout-ms', 100, 10_000
    ),
    only: values.only
      ? new Set(values.only.split(',').map((item) => item.trim()).filter(Boolean))
      : null,
    output: values.output ? path.resolve(values.output) : null,
  };
}

async function runSql(database, sql, params, options) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${options.statementTimeoutMs}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${options.lockTimeoutMs}ms'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function captureMinuteDeleteSpec(options) {
  let captured = null;
  await retention.deleteExpiredMinuteBuckets({
    async queryWithStatementTimeout(sql, params) {
      captured = { sql, params };
      return { rows: [{ examined_buckets: 0, minute_buckets: 0 }] };
    },
  }, {
    batchLimit: 100,
    statementTimeoutMs: options.statementTimeoutMs,
    verifiedCoverage: { from: options.from, through: options.to },
  });
  return {
    name: 'retention-delete-1m', readOnly: false,
    sql: captured.sql, params: captured.params,
  };
}

async function buildPlanSpecs(options, token) {
  const addresses = [token];
  const minuteStartsAt = new Date(options.to);
  minuteStartsAt.setUTCDate(minuteStartsAt.getUTCDate() - 14);
  const page = [options.from, options.to, null, options.tokenLimit];
  const tokenPage = [options.from, options.to, null, options.tokenLimit];
  const range = [options.from, options.to];
  const specs = [
    {
      name: 'backfill-hourly-upsert', readOnly: false,
      sql: aggregate.HOURLY_REFRESH_SQL, params: page,
    },
    {
      name: 'backfill-fine-upsert', readOnly: false,
      sql: aggregate.buildAggregateRangeSql({
        table: 'robinhood_market_buckets_1m', minutes: 1,
      }),
      params: [...range, [5, 15, 30], null, options.tokenLimit],
    },
    {
      name: 'backfill-coarse-upsert', readOnly: false,
      sql: aggregate.buildAggregateRangeSql({
        table: 'robinhood_market_buckets_1h', minutes: 60,
      }),
      params: [...range, [60, 240, 1440], null, options.tokenLimit],
    },
    {
      name: 'audit-token-page', readOnly: true,
      sql: auditor.TOKEN_PAGE_SQL, params: tokenPage,
    },
    {
      name: 'audit-hourly', readOnly: true,
      sql: auditor.buildHourlyAuditSql(), params: [addresses, ...range],
    },
    {
      name: 'audit-aggregate-5m', readOnly: true,
      sql: auditor.buildAggregateAuditSql(5), params: [addresses, ...range],
    },
    {
      name: 'audit-aggregate-240m', readOnly: true,
      sql: auditor.buildAggregateAuditSql(240), params: [addresses, ...range],
    },
    {
      name: 'history-aggregate-5m', readOnly: true,
      sql: history.AGGREGATE_HISTORY_SQL, params: [addresses, ...range, 5, 1001],
    },
    {
      name: 'history-legacy-5m', readOnly: true,
      sql: history.LEGACY_HISTORY_SQL,
      params: [addresses, ...range, 5, minuteStartsAt, 1001, null, null],
    },
    {
      name: 'history-aggregate-240m', readOnly: true,
      sql: history.AGGREGATE_HISTORY_SQL, params: [addresses, ...range, 240, 1001],
    },
    {
      name: 'history-legacy-240m', readOnly: true,
      sql: history.LEGACY_HISTORY_SQL,
      params: [addresses, ...range, 240, minuteStartsAt, 1001, null, null],
    },
    await captureMinuteDeleteSpec(options),
  ];
  if (!options.only) return specs;
  const selected = specs.filter((spec) => options.only.has(spec.name));
  const missing = [...options.only].filter((name) => !specs.some((spec) => spec.name === name));
  if (missing.length) throw new TypeError(`Unknown plan names: ${missing.join(', ')}`);
  return selected;
}

function explainSql(spec, mode) {
  if (mode === 'analyze' && spec.readOnly) {
    return `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) ${spec.sql}`;
  }
  return `EXPLAIN (COSTS, VERBOSE, SETTINGS, FORMAT JSON) ${spec.sql}`;
}

async function explainSpec(database, spec, options) {
  if (options.mode === 'analyze' && !spec.readOnly) {
    return {
      name: spec.name, readOnly: false, status: 'skipped',
      reason: 'ANALYZE is disabled for mutating statements',
    };
  }
  const startedAt = Date.now();
  try {
    const result = await runSql(database, explainSql(spec, options.mode), spec.params, options);
    return {
      name: spec.name, readOnly: spec.readOnly, status: 'ok',
      durationMs: Date.now() - startedAt,
      plan: result.rows[0]?.['QUERY PLAN'] || null,
    };
  } catch (error) {
    return {
      name: spec.name, readOnly: spec.readOnly, status: 'error',
      durationMs: Date.now() - startedAt, error: String(error.message || error),
    };
  }
}

async function findSampleToken(database, options) {
  const result = await runSql(
    database, SAMPLE_TOKEN_SQL, [options.from, options.to], options
  );
  const token = result.rows[0]?.token_address?.toLowerCase() || null;
  if (!token) throw new Error('No Robinhood token found inside the requested interval');
  return token;
}

async function runCollector(options, deps = {}) {
  const database = deps.database || db;
  const token = options.token || await findSampleToken(database, options);
  const specs = await buildPlanSpecs(options, token);
  const stats = await runSql(database, TABLE_STATS_SQL, [], options);
  const plans = [];
  for (const spec of specs) plans.push(await explainSpec(database, spec, options));
  return {
    generatedAt: new Date().toISOString(),
    mode: options.mode, from: options.from, to: options.to, token,
    tableStats: stats.rows, plans,
  };
}

if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  runCollector(options).then(async (report) => {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      await fs.writeFile(options.output, json, { encoding: 'utf8', flag: 'wx' });
      console.log(`Robinhood EXPLAIN report written to ${options.output}`);
    } else {
      console.log(json);
    }
    if (report.plans.some((plan) => plan.status === 'error')) process.exitCode = 1;
  }).catch((error) => {
    console.error(`[RobinhoodExplainCollector] ${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = {
  runCollector,
  __private: {
    SAMPLE_TOKEN_SQL, TABLE_STATS_SQL, buildPlanSpecs, defaultBounds,
    explainSpec, explainSql, parseCliArgs, runSql,
  },
};
