'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseArgs } = require('../src/utils/activate-robinhood-head-processing-state');
const {
  REPAIR_LOCK_KEYS, STOPPED_LEASE_KEYS,
} = require('../src/models/robinhood-head-processing-activation');

describe('Robinhood head processing state activation', () => {
  it('is dry-run by default and bounds operational timeouts', () => {
    assert.deepEqual(parseArgs([]), {
      write: false, lockTimeoutMs: 5000, statementTimeoutMs: 300000,
    });
    assert.deepEqual(parseArgs([
      '--write', '--lock-timeout-ms=9000', '--statement-timeout-ms=600000',
    ]), { write: true, lockTimeoutMs: 9000, statementTimeoutMs: 600000 });
    assert.throws(() => parseArgs(['--force']), /Unknown argument/);
    assert.throws(() => parseArgs(['--write=false']), /does not accept a value/);
    assert.throws(() => parseArgs(['--lock-timeout-ms=0']), /lock timeout/);
  });

  it('fences every runtime owner and manual repair family involved in cutover', () => {
    for (const lease of [
      'robinhood-canonical-head-worker', 'robinhood-processing-worker',
      'robinhood-retention-worker', 'robinhood-derived-worker',
      'robinhood-wallet-swap-live-worker',
    ]) assert.ok(STOPPED_LEASE_KEYS.includes(lease));
    assert.deepEqual(REPAIR_LOCK_KEYS, [
      'robinhood-processing-blocked-recovery',
      'robinhood-v4-liquidity-materialization',
      'robinhood:v3-pruned-capture-repair',
    ]);
  });
});
