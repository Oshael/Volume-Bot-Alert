const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backfillVolumeBuckets = require('../src/utils/backfill-market-volume-buckets-1m');

describe('backfill market volume buckets cli parsing', () => {
  it('defaults to a 48h lookback', () => {
    const parsed = backfillVolumeBuckets.__private.parseCliArgs([]);
    assert.equal(parsed.lookbackHours, 48);
    assert.equal(parsed.all, false);
  });

  it('supports day-based lookback conversion', () => {
    const parsed = backfillVolumeBuckets.__private.parseCliArgs(['--days', '3']);
    assert.equal(parsed.lookbackHours, 72);
  });

  it('supports all-history mode', () => {
    const parsed = backfillVolumeBuckets.__private.parseCliArgs(['--all']);
    assert.equal(parsed.all, true);
    assert.equal(parsed.lookbackHours, null);
  });

  it('rejects invalid numeric arguments', () => {
    assert.throws(
      () => backfillVolumeBuckets.__private.parseCliArgs(['--hours', 'abc']),
      /hours must be an integer/
    );
  });
});
