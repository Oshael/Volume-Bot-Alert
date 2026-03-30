const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');

describe('token market volume 1m bucket helpers', () => {
  it('rounds timestamps down to the start of the minute in UTC', () => {
    const bucketDate = tokenMarketVolumeBucket1m.__private.getBucketDate('2026-03-24T04:18:59.999Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('preserves exact minute boundaries', () => {
    const bucketDate = tokenMarketVolumeBucket1m.__private.getBucketDate('2026-03-24T04:18:00.000Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });
});
