'use strict';

/** Bounded, resumable operator run. No persistent worker or automatic retry. */
const { statfs } = require('node:fs/promises');
const db = require('../models/db');
const { copyPage, parseArgs: parsePageArgs } = require('./copy-robinhood-chain-event-shadow-page');

const MAX_PAGES = 500;
const MIN_ROOT_FREE_BYTES = 20n * 1024n ** 3n;
const MIN_SHADOW_FREE_BYTES = 75n * 1024n ** 3n;
const MAX_CAPTURE_LAG_BLOCKS = 250;

function parseArgs(args = []) {
  const pageArgs = [];
  let maxPages = 1;
  let pauseMs = 100;
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(max-pages|pause-ms)=(\d+)$/.exec(arg);
    if (!match) { pageArgs.push(arg); continue; }
    if (seen.has(match[1])) throw new Error(`repeated argument: ${arg}`);
    seen.add(match[1]);
    if (match[1] === 'max-pages') maxPages = Number(match[2]);
    else pauseMs = Number(match[2]);
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new Error(`max-pages must be between 1 and ${MAX_PAGES}`);
  }
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 0 || pauseMs > 60000) {
    throw new Error('pause-ms must be between 0 and 60000');
  }
  return { ...parsePageArgs(pageArgs), maxPages, pauseMs };
}

async function availableBytes(path) {
  const stats = await statfs(path);
  return BigInt(stats.bavail) * BigInt(stats.bsize);
}

async function shadowVolumePath(database) {
  const { rows } = await database.query(`SELECT pg_tablespace_location(
      COALESCE(NULLIF(relation.reltablespace, 0), catalog.dattablespace)) AS path
    FROM pg_class relation
    JOIN pg_database catalog ON catalog.datname=current_database()
    WHERE relation.oid='public.robinhood_chain_events_shadow'::regclass`);
  const path = rows[0]?.path;
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('shadow must use an explicit filesystem tablespace');
  }
  return path;
}

async function checkHealth(database, volumePath) {
  const [rootFree, shadowFree, lease] = await Promise.all([
    availableBytes('/'), availableBytes(volumePath),
    database.query(`SELECT lease_until>NOW() AND heartbeat_at>NOW()-INTERVAL '2 minutes'
        AS fresh, metadata->>'eventShadowEnabled' AS enabled,
        metadata->>'lagBlocks' AS lag, metadata->'lastError' AS last_error,
        metadata->>'recoveryState' AS recovery_state
      FROM worker_leases WHERE lease_key='robinhood-chain-capture-worker'`),
  ]);
  return evaluateHealth(lease.rows[0], rootFree, shadowFree);
}

function evaluateHealth(capture, rootFree, shadowFree) {
  const lag = Number(capture?.lag);
  const healthy = capture?.fresh === true && capture.enabled === 'true'
    && capture.recovery_state === 'running' && capture.last_error == null
    && capture.lag != null && Number.isFinite(lag)
    && lag >= 0 && lag <= MAX_CAPTURE_LAG_BLOCKS;
  if (rootFree < MIN_ROOT_FREE_BYTES || shadowFree < MIN_SHADOW_FREE_BYTES) {
    return { ready: false, reason: 'disk_floor', rootFree: rootFree.toString(),
      shadowFree: shadowFree.toString() };
  }
  if (!healthy) return { ready: false, reason: 'capture_health', lag: capture?.lag ?? null };
  return { ready: true, lag, rootFree: rootFree.toString(),
    shadowFree: shadowFree.toString() };
}

async function runPages(input, deps = {}) {
  const database = deps.database || db;
  const copy = deps.copy || copyPage;
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const progress = deps.progress || (() => {});
  const maxPages = input.maxPages ?? 1;
  const pauseMs = input.pauseMs ?? 100;
  const volumePath = input.apply ? await (deps.volumePath || shadowVolumePath)(database) : null;
  const guard = deps.guard || checkHealth;
  let nextBlock = input.fromBlock;
  let pages = 0;
  let inserted = 0;
  let stopReason = 'page_limit';
  while (pages < maxPages && nextBlock <= input.throughBlock) {
    if (input.apply) {
      const health = await guard(database, volumePath);
      if (!health.ready) {
        progress({ phase: 'paused', nextBlock, ...health });
        stopReason = health.reason;
        break;
      }
    }
    const result = await copy({ ...input, fromBlock: nextBlock }, { database });
    pages += 1;
    inserted += result.inserted;
    nextBlock = result.nextBlock;
    progress({ phase: 'page', page: pages, ...result });
    if (nextBlock == null) { stopReason = 'complete'; break; }
    if (pages < maxPages) await pause(pauseMs);
  }
  return { mode: input.apply ? 'apply' : 'read-only', pages, inserted,
    nextBlock, stopReason };
}

async function main(args = process.argv.slice(2)) {
  try {
    const report = await runPages(parseArgs(args), {
      progress: (entry) => console.log(JSON.stringify(entry)),
    });
    console.log(JSON.stringify({ phase: 'summary', ...report }));
    if (report.stopReason === 'disk_floor' || report.stopReason === 'capture_health') {
      process.exitCode = 2;
    }
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood chain event shadow batch copy failed:', error.message);
  process.exitCode = 1;
});

module.exports = { MAX_PAGES, checkHealth, evaluateHealth, parseArgs,
  runPages, shadowVolumePath };
