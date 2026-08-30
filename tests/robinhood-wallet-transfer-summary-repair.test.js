const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  cutoffDay,
} = require('../src/models/robinhood-wallet-transfer-summary-repair');
const {
  parseArgs,
} = require('../src/utils/repair-robinhood-wallet-transfer-summary');

it('keeps the repair behind the retention boundary and explicit confirmation', () => {
  assert.equal(cutoffDay(new Date('2026-08-30T12:00:00Z')), '2026-07-31');
  assert.deepEqual(parseArgs([
    '--day=2026-07-18', '--projection-version=rh_transfer_v1',
  ]), {
    apply: false, confirm: false,
    partitionDay: '2026-07-18', projectionVersion: 'rh_transfer_v1',
  });
  assert.throws(() => parseArgs([
    '--day=2026-07-18', '--projection-version=rh_transfer_v1', '--apply',
  ]), /must be provided together/);
  assert.deepEqual(parseArgs([
    '--day=2026-07-18', '--projection-version=rh_transfer_v1',
    '--apply', '--confirm-rebuild-robinhood-transfer-summary',
  ]).apply, true);
});
