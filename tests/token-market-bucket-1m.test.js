const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market 1m bucket helpers', () => {
  it('rounds timestamps down to the start of the minute in UTC', () => {
    const bucketDate = tokenMarketBucket1m.__private.getBucketDate('2026-03-24T04:18:59.999Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('preserves exact minute boundaries', () => {
    const bucketDate = tokenMarketBucket1m.__private.getBucketDate('2026-03-24T04:18:00.000Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });
});
