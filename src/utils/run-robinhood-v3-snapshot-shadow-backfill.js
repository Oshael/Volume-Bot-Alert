'use strict';

/** Bounded operator run for V3 snapshots in the verified shadow range. */
const { statfs } = require('node:fs/promises');
const db = require('../models/db');
const { parseArgs: parsePageArgs, run: runPage } = require('./backfill-robinhood-v3-snapshot-blocks-from-shadow');
const { checkHealth, shadowVolumePath } = require('./run-robinhood-chain-event-shadow-copy-batches');

const MAX_PAGES = 10000;
const MIN_ROOT_FREE_BYTES = 30n * 1024n ** 3n;

function parseArgs(args = []) {
  const pageArgs = [];
  let maxPages = 1;
  const seen = new Set();
  for (const arg of args) {
    const match = /^--max-pages=(\d+)$/.exec(arg);
    if (!match) { pageArgs.push(arg); continue; }
    if (seen.has('max-pages')) throw new Error('repeated --max-pages');
    seen.add('max-pages');
    maxPages = Number(match[1]);
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new Error(`max-pages must be between 1 and ${MAX_PAGES}`);
  }
  return { ...parsePageArgs(pageArgs), maxPages };
}

async function checkPageHealth(database, volumePath) {
  const stats = await statfs('/');
  const rootFree = BigInt(stats.bavail) * BigInt(stats.bsize);
  const root = evaluateRootFree(rootFree);
  if (!root.ready) return root;
  return checkHealth(database, volumePath);
}

function evaluateRootFree(rootFree) {
  return rootFree < MIN_ROOT_FREE_BYTES
    ? { ready: false, reason: 'root_disk_floor', rootFree: rootFree.toString() }
    : { ready: true, rootFree: rootFree.toString() };
}

async function runPages(input, deps = {}) {
  const database = deps.database || db;
  const run = deps.runPage || runPage;
  const guard = deps.guard || checkPageHealth;
  const volumePath = input.apply
    ? await (deps.volumePath || shadowVolumePath)(database) : null;
  let cursor = input.cursor || null;
  let pages = 0;
  let scanned = 0;
  let filled = 0;
  let stopReason = 'page_limit';
  while (pages < input.maxPages) {
    if (input.apply) {
      const health = await guard(database, volumePath);
      if (!health.ready) {
        deps.progress?.({ phase: 'paused', nextCursor: cursor, ...health });
        stopReason = health.reason;
        break;
      }
    }
    const page = await run({ ...input, cursor, database, closePool: false });
    pages += 1;
    scanned += page.scanned;
    filled += page.filled;
    cursor = page.nextCursor;
    deps.progress?.({ phase: 'page', page: pages, ...page });
    if (page.scanComplete) { stopReason = 'complete'; break; }
    if (!cursor || page.scanned === 0) throw new Error('V3 page did not advance its cursor');
  }
  return { mode: input.apply ? 'apply' : 'read-only', pages, scanned, filled,
    nextCursor: cursor, stopReason };
}

async function main(args = process.argv.slice(2)) {
  const input = parseArgs(args);
  let lastCursor = input.cursor || null;
  let pages = 0;
  let scanned = 0;
  let filled = 0;
  try {
    const result = await runPages(input, { progress: (entry) => {
      if (entry.phase === 'page') {
        lastCursor = entry.nextCursor;
        pages += 1;
        scanned += entry.scanned;
        filled += entry.filled;
      }
      console.log(JSON.stringify(entry));
    } });
    console.log(JSON.stringify({ phase: 'summary', ...result }));
    if (result.stopReason !== 'complete' && result.stopReason !== 'page_limit') {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(JSON.stringify({ phase: 'summary', mode: input.apply ? 'apply' : 'read-only',
      pages, scanned, filled, nextCursor: lastCursor,
      stopReason: 'error', error: error.message }));
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood V3 snapshot batch backfill failed:', error.message);
  process.exitCode = 1;
});

module.exports = { MAX_PAGES, MIN_ROOT_FREE_BYTES, checkPageHealth,
  evaluateRootFree, parseArgs, runPages };
