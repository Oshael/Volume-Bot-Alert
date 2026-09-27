'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { evaluateHealth, parseArgs, runPages } = require(
  '../src/utils/run-robinhood-chain-transaction-shadow-copy-batches');

const GIB = 1024n ** 3n;
const healthy = { fresh: true, shadow_enabled: 'false', lag: '0',
  last_error: null, recovery_state: 'running' };
const free = { root: 21n * GIB, heap: 76n * GIB, index: 51n * GIB };

it('requires healthy capture and free space on all three volumes', () => {
  assert.equal(evaluateHealth(healthy, free).ready, true);
  assert.equal(evaluateHealth(healthy, { ...free, index: 49n * GIB }).reason,
    'disk_floor');
  assert.equal(evaluateHealth({ ...healthy, shadow_enabled: 'true' }, free).reason,
    'capture_health');
  assert.equal(evaluateHealth({ ...healthy, lag: '801' }, free).reason,
    'capture_health');
  assert.equal(evaluateHealth({ ...healthy, fresh: false }, free).reason,
    'capture_health');
});

it('bounds the run and halves dense pages without skipping a block', async () => {
  const input = parseArgs(['--from-block=100', '--through-block=199',
    '--max-blocks=100', '--max-pages=3', '--pause-ms=0', '--apply']);
  const attempts = [];
  const committed = [];
  const report = await runPages(input, {
    database: {}, volumePaths: async () => ({}),
    guard: async () => ({ ready: true }), pause: async () => {},
    copy: async ({ fromBlock, throughBlock, maxBlocks }) => {
      attempts.push([fromBlock, maxBlocks]);
      if (maxBlocks > 25) {
        const error = new Error('dense page');
        error.code = 'transaction_shadow_copy_page_too_large';
        throw error;
      }
      const pageEnd = Math.min(throughBlock, fromBlock + maxBlocks - 1);
      committed.push([fromBlock, pageEnd]);
      return { mode: 'apply', fromBlock, pageEnd,
        nextBlock: pageEnd === throughBlock ? null : pageEnd + 1, inserted: 7 };
    },
  });
  assert.deepEqual(attempts.slice(0, 3), [[100, 100], [100, 50], [100, 25]]);
  assert.deepEqual(committed, [[100, 124], [125, 149], [150, 174]]);
  assert.deepEqual(report, { mode: 'apply', pages: 3, inserted: 21,
    nextBlock: 175, stopReason: 'page_limit' });
  assert.equal(parseArgs(['--from-block=1', '--through-block=500',
    '--max-blocks=500']).maxBlocks, 500);
  assert.throws(() => parseArgs(['--from-block=1', '--through-block=2',
    '--max-pages=10001']), /max-pages/);
});

it('stops before the next write on health failure and reports the committed cursor', async () => {
  const input = parseArgs(['--from-block=100', '--through-block=129',
    '--max-blocks=10', '--max-pages=3', '--pause-ms=0', '--apply']);
  let checks = 0;
  const report = await runPages(input, {
    database: {}, volumePaths: async () => ({}), pause: async () => {},
    guard: async () => (++checks === 1
      ? { ready: true } : { ready: false, reason: 'capture_health' }),
    copy: async ({ fromBlock }) => ({ mode: 'apply', fromBlock,
      pageEnd: fromBlock + 9, nextBlock: fromBlock + 10, inserted: 4 }),
  });
  assert.deepEqual(report, { mode: 'apply', pages: 1, inserted: 4,
    nextBlock: 110, stopReason: 'capture_health' });
});

it('rejects a partial page response before advancing the cursor', async () => {
  const input = parseArgs(['--from-block=100', '--through-block=199',
    '--max-blocks=100', '--max-pages=1', '--apply']);
  await assert.rejects(runPages(input, {
    database: {}, volumePaths: async () => ({}),
    guard: async () => ({ ready: true }),
    copy: async () => ({ mode: 'apply', fromBlock: 100,
      pageEnd: 100, nextBlock: null, inserted: 1 }),
  }), /did not confirm the complete page/);
});
