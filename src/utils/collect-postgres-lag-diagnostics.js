'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');

const DEFAULT_DURATION_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_DURATION_MS = 30_000;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const APPLICATION_NAME = 'trendscope-postgres-lag-diagnostic';

function durationMs(value, label) {
  const match = /^(\d+)(s|m|h)$/.exec(String(value || '').trim());
  if (!match) throw new Error(`${label} must use s, m, or h (example: 30m)`);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
  return Number(match[1]) * multiplier;
}

function parseArgs(argv = [], cwd = process.cwd()) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(duration|interval|output)=(.+)$/.exec(argument);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    if (values[match[1]] != null) throw new Error(`--${match[1]} cannot be repeated`);
    values[match[1]] = match[2];
  }
  const duration = values.duration ? durationMs(values.duration, '--duration') : DEFAULT_DURATION_MS;
  const interval = values.interval ? durationMs(values.interval, '--interval') : DEFAULT_INTERVAL_MS;
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    throw new Error('--duration must be between 30s and 24h');
  }
  if (interval < 2_000 || interval > 60_000 || interval >= duration) {
    throw new Error('--interval must be between 2s and 60s and shorter than duration');
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const output = path.resolve(cwd, values.output || `postgres-lag-diagnostic-${stamp}.jsonl`);
  return Object.freeze({ durationMs: duration, intervalMs: interval, output });
}

async function detectCapabilities(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
            current_setting('server_version') AS server_version,
            to_regclass('pg_catalog.pg_stat_io') IS NOT NULL AS has_stat_io,
            to_regclass('pg_catalog.pg_stat_checkpointer') IS NOT NULL AS has_checkpointer,
            to_regclass('public.pg_stat_statements') IS NOT NULL
              OR to_regclass('pg_catalog.pg_stat_statements') IS NOT NULL
              AS has_stat_statements,
            COALESCE((SELECT authority FROM robinhood_head_processing_authority
                       WHERE chain='robinhood'), 'legacy') AS processing_authority`
  );
  return result.rows[0];
}

function systemSql(capabilities) {
  const io = capabilities.has_stat_io
    ? `(SELECT COALESCE(jsonb_agg(to_jsonb(item)), '[]'::jsonb) FROM pg_stat_io item)`
    : `'[]'::jsonb`;
  const checkpointer = capabilities.has_checkpointer
    ? `(SELECT to_jsonb(item) FROM pg_stat_checkpointer item)` : `'{}'::jsonb`;
  return `SELECT clock_timestamp() AS sampled_at,
    (SELECT jsonb_build_object(
      'xactCommit', xact_commit::text, 'xactRollback', xact_rollback::text,
      'blocksRead', blks_read::text, 'blocksHit', blks_hit::text,
      'tuplesReturned', tup_returned::text, 'tuplesFetched', tup_fetched::text,
      'tuplesInserted', tup_inserted::text, 'tuplesUpdated', tup_updated::text,
      'tuplesDeleted', tup_deleted::text, 'tempFiles', temp_files::text,
      'tempBytes', temp_bytes::text, 'deadlocks', deadlocks::text,
      'blockReadTimeMs', blk_read_time, 'blockWriteTimeMs', blk_write_time,
      'statsReset', stats_reset)
     FROM pg_stat_database WHERE datname=current_database()) AS database,
    (SELECT jsonb_build_object(
      'walRecords', wal_records::text, 'walFpi', wal_fpi::text,
      'walBytes', wal_bytes::text, 'walBuffersFull', wal_buffers_full::text,
      'walWrite', wal_write::text, 'walSync', wal_sync::text,
      'walWriteTimeMs', wal_write_time, 'walSyncTimeMs', wal_sync_time,
      'statsReset', stats_reset) FROM pg_stat_wal) AS wal,
    (SELECT to_jsonb(item) FROM pg_stat_bgwriter item) AS bgwriter,
    ${checkpointer} AS checkpointer, ${io} AS io`;
}

const ACTIVITY_SQL = `WITH activity AS MATERIALIZED (
  SELECT pid, backend_type, application_name, state, wait_event_type, wait_event,
         EXTRACT(EPOCH FROM (clock_timestamp()-query_start))*1000 AS query_ms,
         EXTRACT(EPOCH FROM (clock_timestamp()-xact_start))*1000 AS xact_ms,
         pg_blocking_pids(pid) AS blockers, LEFT(query, 800) AS query
    FROM pg_stat_activity
   WHERE datname=current_database() AND pid<>pg_backend_pid()
     AND application_name<>$1
), waits AS (
  SELECT wait_event_type, wait_event, COUNT(*)::int AS sessions
    FROM activity WHERE wait_event_type IS NOT NULL
   GROUP BY wait_event_type, wait_event
   ORDER BY sessions DESC, wait_event_type, wait_event
), top_activity AS (
  SELECT * FROM activity
   WHERE state<>'idle' OR wait_event_type IS NOT NULL
   ORDER BY query_ms DESC NULLS LAST LIMIT 30
)
SELECT jsonb_build_object(
  'sessions', (SELECT COUNT(*) FROM activity),
  'active', (SELECT COUNT(*) FROM activity WHERE state='active'),
  'waiting', (SELECT COUNT(*) FROM activity WHERE wait_event_type IS NOT NULL),
  'blocked', (SELECT COUNT(*) FROM activity WHERE cardinality(blockers)>0),
  'oldestQueryMs', (SELECT COALESCE(MAX(query_ms),0) FROM activity WHERE state='active'),
  'oldestTransactionMs', (SELECT COALESCE(MAX(xact_ms),0) FROM activity),
  'waits', COALESCE((SELECT jsonb_agg(to_jsonb(waits)) FROM waits),'[]'::jsonb),
  'top', COALESCE((SELECT jsonb_agg(to_jsonb(top_activity)) FROM top_activity),'[]'::jsonb)
) AS value`;

const VACUUM_SQL = `SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) AS value FROM (
  SELECT to_jsonb(progress) || jsonb_build_object(
    'relation', progress.relid::regclass::text,
    'durationMs', EXTRACT(EPOCH FROM (clock_timestamp()-activity.query_start))*1000,
    'waitEventType', activity.wait_event_type, 'waitEvent', activity.wait_event
  ) AS value
  FROM pg_stat_progress_vacuum progress
  LEFT JOIN pg_stat_activity activity USING (pid)
  ORDER BY activity.query_start
) observed`;

const TABLE_SQL = `SELECT relname,
  n_live_tup::text, n_dead_tup::text, n_tup_ins::text, n_tup_upd::text, n_tup_del::text,
  vacuum_count::text, autovacuum_count::text, analyze_count::text, autoanalyze_count::text,
  last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE relname LIKE 'robinhood_%' OR relname LIKE 'token_market_%' OR relname='token_catalog'
ORDER BY relname`;

function processingSql(authority) {
  const table = authority === 'state'
    ? 'robinhood_head_capture_states' : 'robinhood_head_captures';
  return `WITH cursors AS MATERIALIZED (
    SELECT stream, safe_head FROM robinhood_head_capture_cursors WHERE chain='robinhood'
  ), observed AS (
    SELECT cursor.stream, cursor.safe_head, reported.block_number AS pending_block,
           active.block_number AS active_block, claimable.block_number AS claimable_block,
           GREATEST(0, cursor.safe_head-reported.block_number+1) AS lag_blocks,
           GREATEST(0, cursor.safe_head-active.block_number+1) AS active_lag_blocks
      FROM cursors cursor LEFT JOIN LATERAL (
        SELECT block_number FROM ${table} item
         WHERE item.chain='robinhood' AND item.stream=cursor.stream
           AND item.processing_status IN ('pending','leased','blocked')
         ORDER BY item.block_number, item.transaction_index, item.log_index LIMIT 1
      ) reported ON TRUE LEFT JOIN LATERAL (
        SELECT block_number FROM ${table} item
         WHERE item.chain='robinhood' AND item.stream=cursor.stream
           AND item.processing_status IN ('pending','leased')
         ORDER BY item.block_number, item.transaction_index, item.log_index LIMIT 1
      ) active ON TRUE LEFT JOIN LATERAL (
        SELECT block_number FROM ${table} item
         WHERE item.chain='robinhood' AND item.stream=cursor.stream
           AND item.processing_status='pending' AND item.next_attempt_at <= NOW()
         ORDER BY item.block_number, item.transaction_index, item.log_index LIMIT 1
      ) claimable ON TRUE
  ), lease AS (
    SELECT heartbeat_at, lease_until, metadata->'telemetry' AS telemetry
      FROM worker_leases WHERE lease_key='robinhood-processing-worker'
  )
  SELECT jsonb_build_object(
    'authority', $1::text,
    'streams', COALESCE((SELECT jsonb_agg(to_jsonb(observed) ORDER BY stream)
                          FROM observed), '[]'::jsonb),
    'heartbeatAt', lease.heartbeat_at, 'leaseUntil', lease.lease_until,
    'telemetry', COALESCE(lease.telemetry, '{}'::jsonb)
  ) AS value FROM lease`;
}

async function probe(client, name, sql, params, errors) {
  const started = Date.now();
  try {
    const result = await client.query(sql, params);
    return { value: result.rows, durationMs: Date.now() - started };
  } catch (error) {
    errors.push({ probe: name, message: String(error.message || error), at: new Date().toISOString() });
    return { value: [], durationMs: Date.now() - started };
  }
}

async function collectSample(client, capabilities, previous) {
  const errors = [];
  const system = await probe(client, 'system', systemSql(capabilities), [], errors);
  const activity = await probe(client, 'activity', ACTIVITY_SQL, [APPLICATION_NAME], errors);
  const vacuums = await probe(client, 'vacuums', VACUUM_SQL, [], errors);
  const processing = await probe(
    client, 'processing', processingSql(capabilities.processing_authority),
    [capabilities.processing_authority], errors
  );
  const tables = await probe(client, 'tables', TABLE_SQL, [], errors);
  const sampledAt = system.value[0]?.sampled_at || new Date().toISOString();
  const sample = {
    type: 'sample', sampledAt, system: system.value[0] || {},
    activity: activity.value[0]?.value || {}, vacuums: vacuums.value[0]?.value || [],
    processing: processing.value[0]?.value || {}, tables: tables.value,
    probeDurationMs: { system: system.durationMs, activity: activity.durationMs,
      vacuums: vacuums.durationMs, processing: processing.durationMs, tables: tables.durationMs },
    errors,
  };
  sample.rates = sampleRates(previous, sample);
  return sample;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegativeDelta(before, after) {
  const left = number(before);
  const right = number(after);
  return left == null || right == null || right < left ? null : right - left;
}

function sampleRates(previous, current) {
  if (!previous) return {};
  const seconds = (new Date(current.sampledAt) - new Date(previous.sampledAt)) / 1000;
  if (!(seconds > 0)) return {};
  const walBytes = nonnegativeDelta(previous.system.wal?.walBytes, current.system.wal?.walBytes);
  return {
    intervalSeconds: seconds,
    walBytesPerSecond: walBytes == null ? null : walBytes / seconds,
    transactionsPerSecond: (() => {
      const commits = nonnegativeDelta(
        previous.system.database?.xactCommit, current.system.database?.xactCommit
      );
      return commits == null ? null : commits / seconds;
    })(),
  };
}

async function statementSnapshot(client, enabled) {
  if (!enabled) return { available: false, rows: [] };
  try {
    const result = await client.query(
      `SELECT to_jsonb(item) AS value FROM pg_stat_statements item
        WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())`
    );
    return { available: true, rows: result.rows.map(({ value }) => value) };
  } catch (error) {
    return { available: false, rows: [], error: String(error.message || error) };
  }
}

function statementDeltas(before, after, limit = 30) {
  const baseline = new Map(before.rows.map((row) => [String(row.queryid), row]));
  return after.rows.map((row) => {
    const prior = baseline.get(String(row.queryid));
    const initial = (column) => prior ? prior[column] : 0;
    return {
      queryId: String(row.queryid), query: String(row.query || '').slice(0, 1000),
      calls: nonnegativeDelta(initial('calls'), row.calls),
      totalExecTimeMs: nonnegativeDelta(initial('total_exec_time'), row.total_exec_time),
      rows: nonnegativeDelta(initial('rows'), row.rows),
      sharedBlocksRead: nonnegativeDelta(initial('shared_blks_read'), row.shared_blks_read),
      sharedBlocksDirtied: nonnegativeDelta(
        initial('shared_blks_dirtied'), row.shared_blks_dirtied
      ),
      sharedBlocksWritten: nonnegativeDelta(
        initial('shared_blks_written'), row.shared_blks_written
      ),
      tempBlocksWritten: nonnegativeDelta(initial('temp_blks_written'), row.temp_blks_written),
      walBytes: nonnegativeDelta(initial('wal_bytes'), row.wal_bytes),
    };
  }).filter(({ totalExecTimeMs }) => totalExecTimeMs != null && totalExecTimeMs > 0)
    .sort((a, b) => b.totalExecTimeMs - a.totalExecTimeMs).slice(0, limit);
}

function tableDeltas(first, last, limit = 30) {
  const baseline = new Map(first.map((row) => [row.relname, row]));
  return last.map((row) => {
    const prior = baseline.get(row.relname) || {};
    const inserted = nonnegativeDelta(prior.n_tup_ins, row.n_tup_ins);
    const updated = nonnegativeDelta(prior.n_tup_upd, row.n_tup_upd);
    const deleted = nonnegativeDelta(prior.n_tup_del, row.n_tup_del);
    return { table: row.relname, inserted, updated, deleted,
      writes: [inserted, updated, deleted].reduce((sum, value) => sum + (value || 0), 0),
      deadTuples: number(row.n_dead_tup) };
  }).sort((a, b) => b.writes - a.writes).slice(0, limit);
}

function observedCounts(samples, entries, identity, weight = () => 1) {
  const counts = {};
  for (const sample of samples) {
    for (const entry of entries(sample)) {
      const key = identity(entry);
      counts[key] = (counts[key] || 0) + weight(entry);
    }
  }
  return counts;
}

function average(values) {
  const present = values.filter((value) => value != null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function summarize(samples, statementsBefore, statementsAfter) {
  const first = samples[0];
  const last = samples.at(-1);
  const waitSamples = observedCounts(
    samples, (sample) => sample.activity.waits || [],
    (wait) => `${wait.wait_event_type || 'unknown'}:${wait.wait_event || 'unknown'}`,
    (wait) => Number(wait.sessions || 0)
  );
  const vacuumSamples = observedCounts(
    samples, (sample) => sample.vacuums || [],
    (vacuum) => vacuum.relation || vacuum.value?.relation || 'unknown'
  );
  return {
    type: 'summary', startedAt: first?.sampledAt, completedAt: last?.sampledAt,
    samples: samples.length, sampleErrors: samples.reduce((sum, item) => sum + item.errors.length, 0),
    processingStart: first?.processing, processingEnd: last?.processing,
    averageWalBytesPerSecond: average(samples.map((item) => item.rates.walBytesPerSecond)),
    waitSampleCounts: waitSamples, vacuumSampleCounts: vacuumSamples,
    topTableWriteDeltas: tableDeltas(first?.tables || [], last?.tables || []),
    topStatementDeltas: statementDeltas(statementsBefore, statementsAfter),
    statementStatsAvailable: statementsBefore.available && statementsAfter.available,
    statementStatsErrors: [statementsBefore.error, statementsAfter.error].filter(Boolean),
  };
}

function compactLog(sample) {
  const streams = (sample.processing.streams || []).map((item) => (
    `${item.stream}:${item.lag_blocks == null ? 'n/a' : item.lag_blocks}`
  )).join(',');
  const wal = sample.rates.walBytesPerSecond;
  return `${sample.sampledAt} lag=[${streams}] walMBps=${wal == null ? 'n/a' : (wal / 1048576).toFixed(2)}`
    + ` active=${sample.activity.active ?? 'n/a'} waiting=${sample.activity.waiting ?? 'n/a'}`
    + ` blocked=${sample.activity.blocked ?? 'n/a'} vacuums=${sample.vacuums.length}`
    + ` errors=${sample.errors.length}`;
}

async function run(options, dependencies = {}) {
  const database = dependencies.database || db;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now || Date.now;
  const logger = dependencies.logger || console;
  const output = await fs.open(options.output, 'wx');
  let client;
  const samples = [];
  try {
    client = await database.getClient();
    await client.query(`SET application_name = '${APPLICATION_NAME}'`);
    await client.query("SET statement_timeout = '1s'");
    await client.query("SET lock_timeout = '250ms'");
    await client.query('SET default_transaction_read_only = on');
    const capabilities = await detectCapabilities(client);
    await output.write(`${JSON.stringify({ type: 'metadata', startedAt: new Date().toISOString(),
      options, capabilities })}\n`);
    const statementsBefore = await statementSnapshot(client, capabilities.has_stat_statements);
    const started = now();
    let previous = null;
    while (now() - started < options.durationMs) {
      const iterationStarted = now();
      const sample = await collectSample(client, capabilities, previous);
      samples.push(sample);
      previous = sample;
      await output.write(`${JSON.stringify(sample)}\n`);
      logger.log(compactLog(sample));
      const remaining = options.durationMs - (now() - started);
      if (remaining <= 0) break;
      await sleep(Math.min(remaining, Math.max(0, options.intervalMs - (now() - iterationStarted))));
    }
    const statementsAfter = await statementSnapshot(client, capabilities.has_stat_statements);
    const summary = summarize(samples, statementsBefore, statementsAfter);
    await output.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    await output.close().catch(() => {});
    client?.release();
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, dependencies.cwd);
  try {
    const summary = await run(options, dependencies);
    (dependencies.logger || console).log(JSON.stringify({ output: options.output, summary }, null, 2));
    return summary;
  } finally {
    if (!dependencies.database) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('PostgreSQL lag diagnostic failed:', error.message);
  process.exitCode = 1;
});

module.exports = {
  collectSample, main, nonnegativeDelta, parseArgs, run, sampleRates,
  processingSql, statementDeltas, summarize, tableDeltas,
};
