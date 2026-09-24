'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  evaluateHealth, parseArgs, runPages,
} = require('../src/utils/run-robinhood-chain-event-shadow-copy-batches');

const GIB = 1024n ** 3n;
const healthyCapture = {
  fresh: true, enabled: 'true', recovery_state: 'running',
  last_error: null, lag: '0',
};

it('enforces both disk floors and capture health before a write', () => {
  assert.equal(evaluateHealth(healthyCapture, 21n * GIB, 76n * GIB).ready, true);
  assert.equal(evaluateHealth(healthyCapture, 19n * GIB, 76n * GIB).reason, 'disk_floor');
  assert.equal(evaluateHealth(healthyCapture, 21n * GIB, 74n * GIB).reason, 'disk_floor');
  assert.equal(evaluateHealth({ ...healthyCapture, lag: '251' },
    21n * GIB, 76n * GIB).reason, 'capture_health');
  assert.equal(evaluateHealth({ ...healthyCapture, enabled: 'false' },
    21n * GIB, 76n * GIB).reason, 'capture_health');
});

it('reports the last committed cursor and stops before the next page when health fails', async () => {
  const options = parseArgs(['--from-block=100', '--through-block=129',
    '--max-blocks=10', '--max-pages=3', '--pause-ms=0', '--apply']);
  let guardCalls = 0;
  const copied = [];
  const database = {};
  const report = await runPages(options, {
    database, volumePath: async () => '/tmp', pause: async () => {},
    guard: async () => (++guardCalls === 1
      ? { ready: true } : { ready: false, reason: 'capture_health' }),
    copy: async ({ fromBlock }, deps) => {
      assert.equal(deps.database, database);
      copied.push(fromBlock);
      return { fromBlock, nextBlock: fromBlock + 10, inserted: 7 };
    },
  });
  assert.deepEqual(copied, [100]);
  assert.deepEqual(report, { mode: 'apply', pages: 1, inserted: 7,
    nextBlock: 110, stopReason: 'capture_health' });
  assert.throws(() => parseArgs(['--from-block=1', '--through-block=2',
    '--max-pages=501']), /max-pages/);
});

it('reduces only the failing page and retries from the same block', async () => {
  const options = parseArgs(['--from-block=100', '--through-block=199',
    '--max-blocks=100', '--max-pages=1', '--pause-ms=0', '--apply']);
  const attempts = [];
  const report = await runPages(options, {
    database: {}, volumePath: async () => '/tmp',
    guard: async () => ({ ready: true }),
    copy: async ({ fromBlock, maxBlocks }) => {
      attempts.push([fromBlock, maxBlocks]);
      if (maxBlocks > 25) {
        const error = new Error('page too large');
        error.code = 'shadow_copy_page_too_large';
        throw error;
      }
      return { fromBlock, nextBlock: fromBlock + maxBlocks, inserted: 10 };
    },
  });
  assert.deepEqual(attempts, [[100, 100], [100, 50], [100, 25]]);
  assert.equal(report.pages, 1);
  assert.equal(report.nextBlock, 125);
  assert.equal(report.inserted, 10);
});
