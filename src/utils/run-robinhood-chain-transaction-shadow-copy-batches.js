'use strict';

/** Bounded operator copy for canonical transactions; no permanent worker. */
const { statfs } = require('node:fs/promises');
const db = require('../models/db');
const { copyPage, parseArgs: parsePageArgs } = require('./copy-robinhood-chain-transaction-shadow-page');

const MAX_PAGES = 10000;
const MIN_ROOT_FREE = 20n * 1024n ** 3n;
const MIN_HEAP_FREE = 75n * 1024n ** 3n;
const MIN_INDEX_FREE = 50n * 1024n ** 3n;
const MAX_CAPTURE_LAG = 800;
const SHADOW = 'public.robinhood_chain_transactions_shadow';
const INDEX = 'public.rh_chain_transactions_shadow_index_key';

function parseArgs(args = []) {
  const pageArgs = [];
  const extra = {};
  for (const arg of args) {
    const match = /^--(max-pages|pause-ms)=(\d+)$/.exec(arg);
    if (!match) { pageArgs.push(arg); continue; }
    if (extra[match[1]] != null) throw new Error(`duplicate argument: ${arg}`);
    extra[match[1]] = Number(match[2]);
  }
  const maxPages = extra['max-pages'] ?? 1;
  const pauseMs = extra['pause-ms'] ?? 100;
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

async function volumePaths(database) {
  const { rows } = await database.query(`SELECT item.kind,
      pg_tablespace_location(COALESCE(NULLIF(relation.reltablespace, 0),
        catalog.dattablespace)) AS path
    FROM (VALUES ('heap', $1::text), ('index', $2::text)) item(kind, name)
    JOIN pg_class relation ON relation.oid=to_regclass(item.name)
    JOIN pg_database catalog ON catalog.datname=current_database()`, [SHADOW, INDEX]);
  const paths = Object.fromEntries(rows.map((row) => [row.kind, row.path]));
  if (!['heap', 'index'].every((key) => typeof paths[key] === 'string'
      && paths[key].startsWith('/'))) {
    throw new Error('transaction shadow heap and index need explicit tablespaces');
  }
  return paths;
}

function captureReady(capture) {
  const lag = Number(capture?.lag);
  return capture?.fresh === true && capture.shadow_enabled === 'false'
    && capture.recovery_state === 'running' && capture.last_error == null
    && capture.lag != null && Number.isFinite(lag)
    && lag >= 0 && lag <= MAX_CAPTURE_LAG;
}

function evaluateHealth(capture, free) {
  if (free.root < MIN_ROOT_FREE || free.heap < MIN_HEAP_FREE
      || free.index < MIN_INDEX_FREE) {
    return { ready: false, reason: 'disk_floor',
      freeBytes: Object.fromEntries(Object.entries(free)
        .map(([key, value]) => [key, value.toString()])) };
  }
  if (!captureReady(capture)) {
    return { ready: false, reason: 'capture_health', lag: capture?.lag ?? null };
  }
  return { ready: true, lag: Number(capture.lag) };
}

async function checkHealth(database, paths, available = availableBytes) {
  const [root, heap, index, lease] = await Promise.all([
    available('/'), available(paths.heap), available(paths.index),
    database.query(`SELECT lease_until>NOW()
        AND heartbeat_at>NOW()-INTERVAL '2 minutes' AS fresh,
        metadata->>'transactionShadowEnabled' AS shadow_enabled,
        metadata->>'lagBlocks' AS lag, metadata->'lastError' AS last_error,
        metadata->>'recoveryState' AS recovery_state
      FROM worker_leases WHERE lease_key='robinhood-chain-capture-worker'`),
  ]);
  return evaluateHealth(lease.rows[0], { root, heap, index });
}

async function adaptivePage(input, nextBlock, width, copy, database, progress) {
  let blocks = width;
  for (;;) {
    try {
      const result = await copy({ ...input, fromBlock: nextBlock, maxBlocks: blocks },
        { database });
      return { result, blocks };
    } catch (error) {
      if (error.code !== 'transaction_shadow_copy_page_too_large' || blocks === 1) {
        throw error;
      }
      blocks = Math.max(1, Math.floor(blocks / 2));
      progress({ phase: 'page_reduced', nextBlock, maxBlocks: blocks });
    }
  }
}

function assertPage(result, input, nextBlock, blocks) {
  const pageEnd = Math.min(input.throughBlock, nextBlock + blocks - 1);
  const expectedNext = pageEnd === input.throughBlock ? null : pageEnd + 1;
  if (result.fromBlock !== nextBlock || result.pageEnd !== pageEnd
      || result.nextBlock !== expectedNext
      || result.mode !== (input.apply ? 'apply' : 'read-only')
      || !Number.isSafeInteger(result.inserted) || result.inserted < 0) {
    throw new Error('transaction shadow copy did not confirm the complete page');
  }
  return expectedNext;
}

async function blockedHealth(input, guard, database, paths) {
  if (!input.apply) return null;
  const health = await guard(database, paths);
  return health.ready ? null : health;
}

async function runPages(input, deps = {}) {
  const database = deps.database || db;
  const copy = deps.copy || copyPage;
  const guard = deps.guard || checkHealth;
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const progress = deps.progress || (() => {});
  const paths = input.apply ? await (deps.volumePaths || volumePaths)(database) : null;
  let nextBlock = input.fromBlock;
  let pages = 0;
  let inserted = 0;
  let width = input.maxBlocks;
  let stablePages = 0;
  let stopReason = 'page_limit';
  while (pages < input.maxPages && nextBlock <= input.throughBlock) {
    const health = await blockedHealth(input, guard, database, paths);
    if (health) {
      progress({ phase: 'paused', nextBlock, ...health });
      stopReason = health.reason;
      break;
    }
    const page = await adaptivePage(input, nextBlock, width, copy, database, progress);
    const next = assertPage(page.result, input, nextBlock, page.blocks);
    stablePages = page.blocks < width ? 0 : stablePages + 1;
    width = page.blocks;
    if (stablePages >= 16 && width < input.maxBlocks) {
      width = Math.min(input.maxBlocks, width * 2);
      stablePages = 0;
    }
    pages += 1;
    inserted += page.result.inserted;
    nextBlock = next;
    progress({ phase: 'page', page: pages, ...page.result });
    if (nextBlock == null) { stopReason = 'complete'; break; }
    if (pages < input.maxPages) await pause(input.pauseMs);
  }
  return { mode: input.apply ? 'apply' : 'read-only', pages, inserted,
    nextBlock, stopReason };
}

async function main(args = process.argv.slice(2)) {
  const input = parseArgs(args);
  let lastNextBlock = input.fromBlock;
  let pages = 0;
  let inserted = 0;
  try {
    const report = await runPages(input, { progress: (entry) => {
      if (entry.phase === 'page') {
        pages = entry.page;
        inserted += entry.inserted;
        lastNextBlock = entry.nextBlock;
      }
      if (entry.phase !== 'page' || pages % 50 === 0 || entry.nextBlock == null) {
        console.log(JSON.stringify(entry));
      }
    } });
    console.log(JSON.stringify({ phase: 'summary', ...report }));
    if (!['complete', 'page_limit'].includes(report.stopReason)) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ phase: 'summary', mode: input.apply ? 'apply' : 'read-only',
      pages, inserted, nextBlock: lastNextBlock, stopReason: 'error',
      errorCode: error.code || null, error: error.message }));
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transaction shadow batch copy failed:', error.message);
  process.exitCode = 1;
});

module.exports = { checkHealth, evaluateHealth, parseArgs, runPages, volumePaths };
