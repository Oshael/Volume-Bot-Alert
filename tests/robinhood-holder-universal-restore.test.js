'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { rangeOf } = require('../src/services/robinhood-holder-universal-restore');
const { parseArgs } = require('../src/utils/restore-robinhood-holder-universal-range');

it('bounds explicit restore ranges and keeps the CLI preview-only by default', () => {
  assert.deepEqual(rangeOf({ fromBlock: '100', toBlock: '101' }), {
    fromBlock: '100', toBlock: '101', blocks: 2,
  });
  for (const range of [
    { fromBlock: '100', toBlock: '99' },
    { fromBlock: '100', toBlock: '350' },
    { fromBlock: '-1', toBlock: '10' },
  ]) assert.throws(() => rangeOf(range));
  assert.deepEqual(parseArgs(['--from=100', '--to=101']), {
    fromBlock: '100', toBlock: '101', apply: false,
  });
  assert.equal(parseArgs(['--from=100', '--to=101', '--apply']).apply, true);
  assert.throws(() => parseArgs(['--from=100', '--to=101', '--force']));
});
