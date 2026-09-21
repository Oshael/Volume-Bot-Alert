'use strict';

require('dotenv').config();

const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');

const CHAIN_ID = 4663n;
const LEASE_KEY = 'robinhood-token-deployment-worker';

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(sample-seconds|probe-blocks|timeout-ms)=(.+)$/.exec(argument);
    if (!match || values[match[1]] != null) {
      throw new Error(`unknown or repeated argument: ${argument}`);
    }
    values[match[1]] = match[2];
  }
  return Object.freeze({
    sampleSeconds: bounded(values['sample-seconds'], 30, 5, 300, '--sample-seconds'),
    probeBlocks: bounded(values['probe-blocks'], 1, 1, 3, '--probe-blocks'),
    timeoutMs: bounded(values['timeout-ms'], 15_000, 1000, 60_000, '--timeout-ms'),
  });
}

function integer(value) { return Number(value || 0); }
function counter(telemetry, name) {
  const value = Number(telemetry?.[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function loadSnapshot(database, sampledAt, windowStart = null) {
  const { rows } = await database.query(`/* deployment-live-window:snapshot */
    WITH queue AS (
      SELECT COUNT(*) FILTER (WHERE status<>'archive_required')::int AS items,
        COUNT(*) FILTER (WHERE status='archive_required')::int AS archive_required,
        COUNT(*) FILTER (WHERE status='leased')::int AS leased,
        COUNT(*) FILTER (WHERE status<>'archive_required'
          AND next_attempt_at<=NOW())::int AS due_now,
        COUNT(*) FILTER (WHERE status<>'archive_required'
          AND created_at<=$1::timestamptz-INTERVAL '48 hours')::int AS older_48h,
        COUNT(*) FILTER (WHERE status<>'archive_required'
          AND created_at<=$1::timestamptz-INTERVAL '72 hours')::int AS older_72h,
        COUNT(*) FILTER (WHERE status<>'archive_required'
          AND live_deadline_at>$1::timestamptz
          AND live_deadline_at<=$1::timestamptz+INTERVAL '1 hour')::int AS expiring_next_hour,
        COUNT(*) FILTER (WHERE $2::timestamptz IS NOT NULL
          AND archive_required_at>$2::timestamptz
          AND archive_required_at<=$1::timestamptz)::int AS aged_out_during_sample,
        EXTRACT(EPOCH FROM ($1::timestamptz
          -MAX(created_at) FILTER (WHERE status<>'archive_required')))::bigint AS newest_age_s,
        EXTRACT(EPOCH FROM ($1::timestamptz
          -MIN(created_at) FILTER (WHERE status<>'archive_required')))::bigint AS oldest_age_s,
        MAX(attempt_count) FILTER (WHERE status<>'archive_required')::int AS max_attempts
      FROM robinhood_token_deployment_outbox WHERE chain='robinhood'
    )
    SELECT queue.*, lease.owner_id, lease.acquired_at, lease.heartbeat_at,
      lease.lease_until>NOW() AS lease_active, lease.metadata->'telemetry' AS telemetry
    FROM queue LEFT JOIN worker_leases lease ON lease.lease_key=$3`,
  [sampledAt, windowStart, LEASE_KEY]);
  const row = rows[0] || {};
  return Object.freeze({
    sampledAt: new Date(sampledAt).toISOString(), items: integer(row.items),
    archiveRequired: integer(row.archive_required),
    leased: integer(row.leased), dueNow: integer(row.due_now),
    older48h: integer(row.older_48h), older72h: integer(row.older_72h),
    expiringNextHour: integer(row.expiring_next_hour),
    agedOutDuringSample: integer(row.aged_out_during_sample),
    newestAgeS: row.newest_age_s == null ? null : Number(row.newest_age_s),
    oldestAgeS: row.oldest_age_s == null ? null : Number(row.oldest_age_s),
    maxAttempts: row.max_attempts == null ? null : Number(row.max_attempts),
    lease: Object.freeze({ active: row.lease_active === true, ownerId: row.owner_id || null,
      acquiredAt: row.acquired_at ? new Date(row.acquired_at).toISOString() : null,
      heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null }),
    counters: Object.freeze({
      totalRuns: counter(row.telemetry, 'totalRuns'),
      totalResolved: counter(row.telemetry, 'totalResolved'),
      totalSkipped: counter(row.telemetry, 'totalSkipped'),
      totalDeferred: counter(row.telemetry, 'totalDeferred'),
      totalArchiveRequired: counter(row.telemetry, 'totalArchiveRequired'),
    }),
  });
}

function delta(after, before) {
  return after == null || before == null || after < before ? null : after - before;
}

function summarize(start, end, elapsedSeconds) {
  const sameLease = start.lease.ownerId != null && start.lease.ownerId === end.lease.ownerId
    && start.lease.acquiredAt === end.lease.acquiredAt;
  const resolved = sameLease ? delta(end.counters.totalResolved, start.counters.totalResolved) : null;
  const skipped = sameLease ? delta(end.counters.totalSkipped, start.counters.totalSkipped) : null;
  const archived = sameLease
    ? delta(end.counters.totalArchiveRequired, start.counters.totalArchiveRequired) : null;
  const completed = resolved == null || skipped == null ? null : resolved + skipped;
  const arrivals = completed == null || archived == null
    ? null : Math.max(0, end.items - start.items + completed + archived);
  const rate = (value) => value == null ? null : Number((value / elapsedSeconds).toFixed(4));
  return Object.freeze({
    elapsedSeconds, comparableWorkerCounters: sameLease,
    arrivals, completed, resolved, skipped, archived,
    arrivalsPerSecond: rate(arrivals), completedPerSecond: rate(completed),
    netDrainPerSecond: rate(start.items - end.items),
    backlogDelta: end.items - start.items, agedOutDuringSample: end.agedOutDuringSample,
  });
}

async function selectProbeBlocks(database, limit) {
  const { rows } = await database.query(`/* deployment-live-window:probe-blocks */
    WITH recent AS (
      SELECT block_number, block_hash FROM robinhood_chain_blocks
      WHERE chain='robinhood' AND canonical ORDER BY block_number DESC LIMIT 64
    )
    SELECT recent.block_number::text, recent.block_hash,
      COUNT(transaction.transaction_hash)::int AS transactions
    FROM recent LEFT JOIN robinhood_chain_transactions transaction
      ON transaction.chain='robinhood' AND transaction.block_hash=recent.block_hash
    GROUP BY recent.block_number, recent.block_hash
    ORDER BY (COUNT(transaction.transaction_hash)=0),
      COUNT(transaction.transaction_hash), recent.block_number DESC LIMIT $1::int`, [limit]);
  return rows.map((row) => Object.freeze({ blockNumber: String(row.block_number),
    blockHash: row.block_hash, transactions: integer(row.transactions) }));
}

function rpcError(error) {
  return { code: String(error?.rpcCode ?? error?.code ?? 'rpc_error'),
    message: String(error?.message || error).slice(0, 300) };
}

async function probeMethod(client, method, params, now) {
  const started = now();
  try {
    const value = await client.request(method, params);
    return Object.freeze({ supported: true, latencyMs: Math.max(0, now() - started),
      entries: Array.isArray(value) ? value.length : value == null ? 0 : 1 });
  } catch (error) {
    return Object.freeze({ supported: false, latencyMs: Math.max(0, now() - started),
      error: rpcError(error) });
  }
}

async function probeRpc(options, blocks, deps = {}) {
  if (!blocks.length) return Object.freeze({ status: 'no_canonical_blocks', blocks: [] });
  const env = deps.env || process.env;
  const url = String(env.RH_NODE_RPC_URL || env.ROBINHOOD_RPC_URL || '').trim();
  if (!url) return Object.freeze({ status: 'not_configured', blocks: [] });
  const client = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-deployment-live-probe', url }],
    timeoutMs: options.timeoutMs, maxRetries: 0,
  });
  if (BigInt(await client.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('deployment LIVE RPC is not Robinhood Chain');
  }
  const now = deps.now || Date.now;
  const results = [];
  for (const block of blocks) {
    const tag = `0x${BigInt(block.blockNumber).toString(16)}`;
    const canonical = await client.request('eth_getBlockByNumber', [tag, false]);
    if (String(canonical?.hash || '').toLowerCase() !== block.blockHash) {
      throw new Error(`RPC block ${block.blockNumber} diverged from PostgreSQL`);
    }
    results.push(Object.freeze({ ...block,
      traceBlock: await probeMethod(client, 'trace_block', [tag], now),
      debugTraceBlock: await probeMethod(client, 'debug_traceBlockByNumber', [
        tag, { tracer: 'callTracer', timeout: `${options.timeoutMs}ms` },
      ], now) }));
  }
  return Object.freeze({ status: 'probed', blocks: results });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv); const database = deps.database || db;
  const now = deps.now || Date.now; const pause = deps.pause
    || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startMs = now();
  const start = await (deps.loadSnapshot || loadSnapshot)(database, new Date(startMs), null);
  const blocks = await (deps.selectProbeBlocks || selectProbeBlocks)(database, options.probeBlocks);
  const rpc = await (deps.probeRpc || probeRpc)(options, blocks, deps);
  await pause(options.sampleSeconds * 1000);
  const endMs = now();
  const end = await (deps.loadSnapshot || loadSnapshot)(database, new Date(endMs), new Date(startMs));
  const elapsedSeconds = Math.max(1, (endMs - startMs) / 1000);
  const report = Object.freeze({ mode: 'read-only', action: 'none', options,
    queue: { start, end, sample: summarize(start, end, elapsedSeconds) }, rpc });
  (deps.logger || console).log(JSON.stringify(report, null, 2)); return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood deployment live-window audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { loadSnapshot, main, parseArgs, probeRpc, selectProbeBlocks, summarize,
  __private: { probeMethod } };
