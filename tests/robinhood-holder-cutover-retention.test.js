'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { parseArgs } = require('../src/utils/cutover-robinhood-holder-capture');
const { normalizeOptions } = require('../src/services/robinhood-chain-event-pruner');

it('keeps cutover preview-only by default and requires an exact apply anchor', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--apply', '--expect-next=101',
    `--expect-hash=0x${'a'.repeat(64)}`]), {
    apply: true, expectedNextBlock: '101', expectedCheckpointHash: `0x${'a'.repeat(64)}`,
  });
  assert.throws(() => parseArgs(['--apply']), /requires/);
  assert.throws(() => parseArgs(['--expect-next=101']), /require --apply/);
  assert.throws(() => normalizeOptions({ retentionMs: 0 }), /retentionMs must be between/);
});
