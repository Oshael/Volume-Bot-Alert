'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { parseArgs } = require('../src/utils/cutover-robinhood-holder-capture');
const { normalizeOptions } = require('../src/services/robinhood-chain-event-pruner');
const {
  __private: { statementTimeout },
} = require('../src/services/robinhood-holder-cutover-gate');

it('keeps cutover preview-only by default and requires an exact apply anchor', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--apply', '--expect-next=101',
    `--expect-hash=0x${'a'.repeat(64)}`, '--statement-timeout-ms=60000']), {
    apply: true, expectedNextBlock: '101', expectedCheckpointHash: `0x${'a'.repeat(64)}`,
    statementTimeoutMs: 60_000,
  });
  assert.throws(() => parseArgs(['--apply']), /requires/);
  assert.throws(() => parseArgs(['--expect-next=101']), /require --apply/);
  assert.throws(() => parseArgs(['--statement-timeout-ms=slow']), /integer/);
  assert.equal(statementTimeout(), 15_000);
  assert.equal(statementTimeout(60_000), 60_000);
  assert.throws(() => statementTimeout(14_999), /between 15000 and 60000/);
  assert.throws(() => statementTimeout(60_001), /between 15000 and 60000/);
  assert.throws(() => normalizeOptions({ retentionMs: 0 }), /retentionMs must be between/);
});
