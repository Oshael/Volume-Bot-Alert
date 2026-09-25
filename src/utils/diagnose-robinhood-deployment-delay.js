'use strict';

require('dotenv').config();

const db = require('../models/db');

const DEPLOYMENT_LEASE = 'robinhood-token-deployment-worker';
const REDISTRIBUTION_LEASE = 'robinhood-bundle-redistribution-live-worker';
const APPLICATION_NAME = 'robinhood-deployment-delay-diagnostic';
const LEASE_SQL = `SELECT clock_timestamp() AS sampled_at, lease_key, owner_id,
    acquired_at, heartbeat_at, metadata->'telemetry' AS telemetry
  FROM worker_leases WHERE lease_key = ANY($1::text[])`;
const ACTIVITY_SQL = `SELECT clock_timestamp() AS sampled_at, pid, backend_type,
    state, wait_event_type, wait_event,
    EXTRACT(EPOCH FROM clock_timestamp() - query_start) AS query_age_s,
    pg_blocking_pids(pid) AS blockers, LEFT(query, 1200) AS query
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
    AND application_name <> $1 AND state <> 'idle'
  ORDER BY query_start NULLS LAST LIMIT 50`;
const MINT_SQL = `WITH head AS (
    SELECT node_head FROM robinhood_chain_capture_cursor WHERE chain = 'robinhood'
  ) SELECT clock_timestamp() AS sampled_at,
    COUNT(*)::int AS unattempted,
    COUNT(*) FILTER (WHERE outbox.next_attempt_at <= NOW())::int AS due,
    COUNT(*) FILTER (WHERE head.node_head - outbox.mint_block_number > 96)::int AS beyond_96,
    MAX(head.node_head - outbox.mint_block_number) AS max_distance_blocks,
    MAX(EXTRACT(EPOCH FROM NOW() - outbox.created_at)) AS max_queue_age_s
  FROM head CROSS JOIN robinhood_token_deployment_outbox outbox
  WHERE outbox.chain = 'robinhood' AND outbox.status = 'pending'
    AND outbox.attempt_count = 0 AND outbox.mint_block_number IS NOT NULL
    AND outbox.created_at >= NOW() - INTERVAL '10 minutes'`;

function durationMs(value) {
  const match = /^(\d+)(s|m)$/.exec(String(value));
  if (!match) throw new Error('use --duration=5m and --interval=2s');
  return Number(match[1]) * (match[2] === 'm' ? 60_000 : 1000);
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(duration|interval)=(.+)$/.exec(argument);
    if (!match || values[match[1]]) throw new Error(`invalid or repeated argument: ${argument}`);
    values[match[1]] = match[2];
  }
  const duration = durationMs(values.duration || '5m');
  const interval = durationMs(values.interval || '2s');
  if (duration < 30_000 || duration > 30 * 60_000) {
    throw new Error('--duration must be between 30s and 30m');
  }
  if (interval < 1000 || interval > 10_000 || interval >= duration) {
    throw new Error('--interval must be between 1s and 10s and shorter than duration');
  }
  return Object.freeze({ durationMs: duration, intervalMs: interval });
}

function numeric(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function delta(first, last, field) {
  const before = numeric(first?.[field]);
  const after = numeric(last?.[field]);
  return before == null || after == null || after < before ? null : after - before;
}

function queryFamily(row) {
  if (row.backend_type === 'autovacuum worker') return 'autovacuum';
  const query = String(row.query || '').toLowerCase();
  // pg_stat_activity may truncate this query before its FROM clause.
  if (/^\s*select buy\.wallet_address as source_wallet\b/.test(query)
      || (query.includes('robinhood_wallet_token_first_buys')
      && query.includes('robinhood_wallet_transfer_edges'))) return 'redistribution_evidence';
  if (query.includes('robinhood_bundle_redistribution_queue')) return 'redistribution_queue';
  if (query.includes('robinhood_token_deployment_outbox')) return 'deployment_outbox';
  if (query.includes('robinhood_wallet_token_first_buys')) return 'first_buy_other_or_truncated';
  return 'other';
}

function compactQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 130);
}

function distillActivity(rows) {
  const families = {};
  const waits = {};
  const longest = [];
  let idleInTransaction = 0;
  for (const row of rows) {
    if (row.state === 'idle in transaction') idleInTransaction += 1;
    if (row.state !== 'active') continue;
    const family = queryFamily(row);
    families[family] = (families[family] || 0) + 1;
    const wait = row.wait_event_type ? `${row.wait_event_type}:${row.wait_event}` : null;
    if (wait) waits[wait] = (waits[wait] || 0) + 1;
    longest.push({ family, ageS: numeric(row.query_age_s) || 0,
      wait, blocked: (row.blockers || []).length > 0,
      query: compactQuery(row.query) });
  }
  return { families, waits, longest: longest.sort((a, b) => b.ageS - a.ageS).slice(0, 5),
    idleInTransaction, truncated: rows.length === 50 };
}

async function probe(client, sql, params, errors, name) {
  try { return (await client.query(sql, params)).rows; } catch (error) {
    errors.push(`${name}: ${String(error.message || error)}`);
    return [];
  }
}

async function collectSample(client, includeMints) {
  const errors = [];
  const leases = await probe(client, LEASE_SQL,
    [[DEPLOYMENT_LEASE, REDISTRIBUTION_LEASE]], errors, 'lease');
  const activity = await probe(client, ACTIVITY_SQL, [APPLICATION_NAME], errors, 'activity');
  const mints = includeMints ? await probe(client, MINT_SQL, [], errors, 'mints') : [];
  return {
    at: new Date().toISOString(),
    deployment: leases.find((row) => row.lease_key === DEPLOYMENT_LEASE) || null,
    redistribution: leases.find((row) => row.lease_key === REDISTRIBUTION_LEASE) || null,
    activity: distillActivity(activity), mints: mints[0] || null, errors,
  };
}

function recordActivity(summary, sample) {
  for (const [family, count] of Object.entries(sample.families)) {
    summary.familySessionSamples[family] = (summary.familySessionSamples[family] || 0) + count;
  }
  for (const [wait, count] of Object.entries(sample.waits)) {
    summary.waitSessionSamples[wait] = (summary.waitSessionSamples[wait] || 0) + count;
  }
  for (const item of sample.longest) {
    summary.maxAgeS[item.family] = Math.max(summary.maxAgeS[item.family] || 0, item.ageS);
    summary.topQueries.push(item);
  }
  if (sample.truncated) summary.truncatedSamples += 1;
  summary.maxIdleInTransaction = Math.max(summary.maxIdleInTransaction,
    sample.idleInTransaction || 0);
}

function recordMints(summary, sample) {
  if (!sample) return;
  summary.samples += 1;
  summary.maxUnattempted = Math.max(summary.maxUnattempted, numeric(sample.unattempted) || 0);
  summary.maxDue = Math.max(summary.maxDue, numeric(sample.due) || 0);
  summary.maxBeyond96 = Math.max(summary.maxBeyond96, numeric(sample.beyond_96) || 0);
  summary.maxDistanceBlocks = Math.max(summary.maxDistanceBlocks,
    numeric(sample.max_distance_blocks) || 0);
  summary.maxQueueAgeS = Math.max(summary.maxQueueAgeS,
    numeric(sample.max_queue_age_s) || 0);
}

function recordPool(summary, seen, sample, intervalMs) {
  const snapshot = sample.deployment?.telemetry?.databasePool;
  const ageMs = Date.parse(sample.at) - Date.parse(snapshot?.sampledAt);
  if (!snapshot?.sampledAt || seen.has(snapshot.sampledAt)
      || !Number.isFinite(ageMs) || ageMs < -2000 || ageMs > intervalMs + 3000) return;
  seen.add(snapshot.sampledAt);
  summary.freshSamples += 1;
  const waiting = numeric(snapshot.waiting) || 0;
  summary.maxWaiting = Math.max(summary.maxWaiting, waiting);
  if (waiting <= 0) return;
  summary.withWaiting += 1;
  const phase = snapshot.phase || 'unknown';
  summary.phasesWithWaiting[phase] = (summary.phasesWithWaiting[phase] || 0) + 1;
  if (sample.activity.families.redistribution_evidence) summary.waitingWithRedistribution += 1;
  else summary.waitingWithoutRedistribution += 1;
  if (sample.activity.families.first_buy_other_or_truncated) {
    summary.waitingWithFirstBuyAmbiguous += 1;
  }
}

function recordPoolPeaks(summary, seen, sample, startedAt) {
  for (const field of ['databasePoolPeakWaitingSample', 'databasePoolRunPeakWaitingSample']) {
    const peak = sample.deployment?.telemetry?.[field];
    const at = Date.parse(peak?.sampledAt);
    if (!Number.isFinite(at) || at < Date.parse(startedAt)
        || at > Date.parse(sample.at) || seen.has(peak.sampledAt)) continue;
    seen.add(peak.sampledAt);
    summary.recordedPeakEvents += 1;
    summary.maxWaiting = Math.max(summary.maxWaiting, numeric(peak.waiting) || 0);
  }
}

function deploymentSummary(leases, oldestHeartbeatAgeS) {
  const first = leases[0];
  const last = leases.at(-1);
  const sameLease = Boolean(first && last && leases.every((lease) => (
    lease.owner_id === first.owner_id
    && String(lease.acquired_at) === String(first.acquired_at)
  )));
  const before = sameLease ? first.telemetry : null;
  const after = sameLease ? last.telemetry : null;
  const attempts = delta(before, after, 'firstAttemptQueueWaitSamples');
  const waitMs = delta(before, after, 'firstAttemptQueueWaitTotalMs');
  return { found: leases.length > 0, sameLease, oldestHeartbeatAgeS,
    firstAttempts: attempts, meanFirstAttemptQueueWaitMs:
      attempts > 0 && waitMs != null ? Math.round(waitMs / attempts) : null,
    firstAttemptsBeyond96: delta(before, after, 'firstAttemptHeadBeyondLookback'),
    firstAttemptLiveResolved: delta(before, after, 'firstAttemptLiveResolved'),
    firstAttemptArchiveResolved: delta(before, after, 'firstAttemptArchiveResolved'),
    lastFailure: last?.telemetry?.lastRunFailure || null };
}

function redistributionSummary(leases, deploymentLast) {
  const first = leases[0];
  const last = leases.at(-1);
  const sameLease = Boolean(first && last && leases.every((lease) => (
    lease.owner_id === first.owner_id
    && String(lease.acquired_at) === String(first.acquired_at)
  )));
  return { found: leases.length > 0,
    sameProcessAsDeployment: last && deploymentLast
      ? last.owner_id === deploymentLast.owner_id : null,
    claimed: sameLease ? delta(first.telemetry, last.telemetry, 'totalClaimed') : null,
    deferred: sameLease ? delta(first.telemetry, last.telemetry, 'totalDeferred') : null };
}

function summarize(samples, options) {
  const deployment = samples.map((item) => item.deployment).filter(Boolean);
  const redistribution = samples.map((item) => item.redistribution).filter(Boolean);
  const startedAt = samples[0]?.at || null;
  const completedAt = samples.at(-1)?.at || null;
  const poolSeen = new Set();
  const peakSeen = new Set();
  const pool = { freshSamples: 0, withWaiting: 0, maxWaiting: 0,
    waitingWithRedistribution: 0, waitingWithoutRedistribution: 0,
    waitingWithFirstBuyAmbiguous: 0, recordedPeakEvents: 0, phasesWithWaiting: {} };
  const activity = { familySessionSamples: {}, waitSessionSamples: {}, maxAgeS: {},
    topQueries: [], truncatedSamples: 0, maxIdleInTransaction: 0 };
  const mint = { samples: 0, maxUnattempted: 0, maxDue: 0, maxBeyond96: 0,
    maxDistanceBlocks: 0, maxQueueAgeS: 0 };
  const errors = [];
  let oldestHeartbeatAgeS = 0;
  for (const sample of samples) {
    errors.push(...sample.errors.map((value) => ({ at: sample.at, message: value })));
    const heartbeatAge = (Date.parse(sample.at) - Date.parse(sample.deployment?.heartbeat_at)) / 1000;
    if (Number.isFinite(heartbeatAge)) oldestHeartbeatAgeS = Math.max(oldestHeartbeatAgeS,
      heartbeatAge);
    recordActivity(activity, sample.activity);
    recordMints(mint, sample.mints);
    recordPool(pool, poolSeen, sample, options.intervalMs);
    recordPoolPeaks(pool, peakSeen, sample, startedAt);
  }
  activity.topQueries.sort((a, b) => b.ageS - a.ageS);
  const querySeen = new Set();
  activity.topQueries = activity.topQueries.filter((item) => {
    const key = `${item.family}:${item.query}`;
    if (querySeen.has(key)) return false;
    querySeen.add(key);
    return true;
  }).slice(0, 5);
  return {
    window: { startedAt, completedAt, requestedSeconds: options.durationMs / 1000,
      samples: samples.length, errors: errors.length },
    worker: deploymentSummary(deployment, oldestHeartbeatAgeS),
    redistribution: redistributionSummary(redistribution, deployment.at(-1)),
    mint, pool, activity, errors: errors.slice(0, 5),
  };
}

function format(report) {
  const { window, worker, redistribution, mint, pool, activity } = report;
  const lines = [
    `Janela: ${window.startedAt} a ${window.completedAt}; ${window.samples} amostras; ${window.errors} erros`,
    `Mints sem primeira tentativa (head da captura): pico ${mint.maxUnattempted}, vencidos >96 ${mint.maxBeyond96}, maior distância ${mint.maxDistanceBlocks} blocos (${mint.samples} amostras)`,
    `Worker: lease estável=${worker.sameLease}; novas primeiras tentativas=${worker.firstAttempts ?? 'indisponível'}; espera média=${worker.meanFirstAttemptQueueWaitMs ?? 'indisponível'} ms; novas além de 96=${worker.firstAttemptsBeyond96 ?? 'indisponível'}`,
    `Redistribution: lease presente=${redistribution.found}; mesmo processo=${redistribution.sameProcessAsDeployment ?? 'indisponível'}; claims=${redistribution.claimed ?? 'indisponível'}; adiamentos=${redistribution.deferred ?? 'indisponível'}`,
    `Pool: ${pool.freshSamples} amostras frescas; ${pool.withWaiting} com fila; ${pool.recordedPeakEvents} picos registrados; máximo ${pool.maxWaiting} esperando; fases=${JSON.stringify(pool.phasesWithWaiting)}`,
    `Coincidência pool com fila: evidência redistribution ativa=${pool.waitingWithRedistribution}; sem evidência redistribution ativa=${pool.waitingWithoutRedistribution}; leitura first-buy ambígua=${pool.waitingWithFirstBuyAmbiguous}`,
    `Sessões ativas por família (soma das amostras): ${JSON.stringify(activity.familySessionSamples)}`,
    `Waits PostgreSQL (soma das amostras): ${JSON.stringify(activity.waitSessionSamples)}`,
    `Maior idade de consulta por família (s): ${JSON.stringify(activity.maxAgeS)}`,
    `Sessões idle in transaction: pico ${activity.maxIdleInTransaction}`,
    `Heartbeat mais antigo observado: ${Math.round(worker.oldestHeartbeatAgeS)} s; consultas truncadas em ${activity.truncatedSamples} amostras`,
    'Consultas mais longas amostradas:',
    ...activity.topQueries.map((item) => `  ${item.ageS.toFixed(1)}s ${item.family} ${item.wait || '-'} ${item.query}`),
    'Leitura causal: coincidência temporal não confirma causa; ausência de amostras frescas ou consultas truncadas limita a comparação.',
  ];
  if (report.errors.length) lines.push(`Erros de coleta: ${JSON.stringify(report.errors)}`);
  return lines.join('\n');
}

async function run(options, dependencies = {}) {
  const database = dependencies.database || db;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const shouldStop = dependencies.shouldStop || (() => false);
  const client = await database.getClient();
  const samples = [];
  try {
    await client.query(`SET application_name = '${APPLICATION_NAME}'`);
    await client.query("SET statement_timeout = '1500ms'");
    await client.query("SET lock_timeout = '250ms'");
    await client.query('SET default_transaction_read_only = on');
    const started = now();
    let nextMintAt = started;
    while (!shouldStop() && now() - started < options.durationMs) {
      const tick = now();
      const includeMints = tick >= nextMintAt;
      if (includeMints) nextMintAt = tick + 10_000;
      samples.push(await collectSample(client, includeMints));
      const remaining = options.durationMs - (now() - started);
      if (remaining <= 0) break;
      await sleep(Math.min(remaining, Math.max(0, options.intervalMs - (now() - tick))));
    }
    return summarize(samples, options);
  } finally { client.release(); }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await run(options, { shouldStop: () => stopping });
    console.log(format(report));
    return report;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood deployment delay diagnostic failed:', error.message);
  process.exitCode = 1;
});

module.exports = { parseArgs, queryFamily, summarize, format, run, main };
