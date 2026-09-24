'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { evaluateRootFree, parseArgs, runPages } = require('../src/utils/run-robinhood-v3-snapshot-shadow-backfill');

it('stops at the root filesystem floor', () => {
  const gib = 1024n ** 3n;
  assert.equal(evaluateRootFree(29n * gib).reason, 'root_disk_floor');
  assert.equal(evaluateRootFree(30n * gib).ready, true);
});

it('requires explicit apply and bounds the number of pages', () => {
  const input = parseArgs(['--from-block=10', '--through-block=20',
    '--batch-size=1000', '--max-pages=100', '--apply']);
  assert.equal(input.apply, true);
  assert.equal(input.maxPages, 100);
  assert.equal(parseArgs(['--from-block=10', '--through-block=20']).apply, undefined);
  assert.throws(() => parseArgs(['--from-block=10', '--through-block=20',
    '--max-pages=10001']), /max-pages/);
});

it('stops before the next write and returns the last committed cursor', async () => {
  const cursors = [];
  let checks = 0;
  const database = {};
  const report = await runPages({ fromBlock: 10, throughBlock: 20,
    batchSize: 1000, apply: true, maxPages: 4, cursor: 'previous' }, {
    database, volumePath: async () => '/tmp',
    guard: async () => (++checks === 1
      ? { ready: true } : { ready: false, reason: 'root_disk_floor' }),
    runPage: async (page) => {
      assert.equal(page.database, database);
      assert.equal(page.closePool, false);
      cursors.push(page.cursor);
      return { scanned: 1000, missing: 1000, filled: 1000,
        nextCursor: 'committed', scanComplete: false };
    },
  });
  assert.deepEqual(cursors, ['previous']);
  assert.deepEqual(report, { mode: 'apply', pages: 1, scanned: 1000,
    filled: 1000, nextCursor: 'committed', stopReason: 'root_disk_floor' });
});

it('continues from the returned cursor and finishes on a short page', async () => {
  const cursors = [];
  const report = await runPages({ fromBlock: 10, throughBlock: 20,
    batchSize: 1000, apply: false, maxPages: 3, cursor: 'previous' }, {
    runPage: async (page) => {
      cursors.push(page.cursor);
      return cursors.length === 1
        ? { scanned: 1000, filled: 0, nextCursor: 'next', scanComplete: false }
        : { scanned: 12, filled: 0, nextCursor: null, scanComplete: true };
    },
  });
  assert.deepEqual(cursors, ['previous', 'next']);
  assert.deepEqual(report, { mode: 'read-only', pages: 2, scanned: 1012,
    filled: 0, nextCursor: null, stopReason: 'complete' });
});
