const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { parseArgs } = require('../src/utils/prune-robinhood-holder-journal');
const db = require('../src/models/db');

after(() => db.pool.end());

test('manual journal cleanup requires an explicit bounded cut and write consent', () => {
  assert.deepEqual(parseArgs(['--before-block=38808102', '--write']), {
    beforeBlock: '38808102', retentionBlocks: 20000, batchLimit: 1000,
  });
  for (const args of [
    [], ['--write'], ['--before-block=38808102'],
    ['--before-block=-1', '--write'], ['--before-block=', '--write'],
    ['--before-block=1e9', '--write'],
    ['--before-block=9223372036854775808', '--write'],
    ['--before-block=1', '--before-block=2', '--write'],
    ['--before-block=1', '--write', '--write'],
    ['--before-block=1', '--batch-limit=1001', '--write'],
    ['--before-block=1', '--batch-limit=0', '--write'],
    ['--before-block=1', '--write', '--force'],
  ]) assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
});
