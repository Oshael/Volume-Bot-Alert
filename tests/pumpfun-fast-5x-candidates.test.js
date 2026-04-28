const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const pumpfunFast5xCandidates = require('../src/services/pumpfun-fast-5x-candidates');

describe('PumpFun fast 5x candidates', () => {
  it('maps database rows into signal input for the pure classifier', () => {
    const mapped = pumpfunFast5xCandidates.__private.mapCandidateRow({
      address: '  So11111111111111111111111111111111111111112  ',
      symbol: 'FAST',
      name: 'Fast Token',
      source: 'PUMPFUN-MIGRATED',
      migration_started_at: '2026-04-27T10:00:00.000Z',
      current_bucket_at: '2026-04-27T10:07:00.000Z',
      migration_age_ms: '420000',
      first_mcap: '24000.50',
      current_mcap: '62000.25',
      p95_mcap_recent: '61000.00',
      p95_vol_5m_recent: '85000.00',
      avg_vol_5m_first_30m: '72000.00',
      time_to_2x_ms: '360000',
      mcap_buckets: '42',
      vol_buckets: '40',
    });

    assert.equal(mapped.address, 'So11111111111111111111111111111111111111112');
    assert.equal(mapped.symbol, 'FAST');
    assert.equal(mapped.source, 'pumpfun-migrated');
    assert.equal(mapped.migrationStartedAt, '2026-04-27T10:00:00.000Z');
    assert.equal(mapped.volumeBucketCount, 40);
    assert.deepEqual(mapped.signalInput, {
      source: 'pumpfun-migrated',
      migrationAgeMs: 420000,
      firstMcap: 24000.5,
      currentMcap: 62000.25,
      p95McapRecent: 61000,
      p95Vol5mRecent: 85000,
      avgVol5mFirst30m: 72000,
      timeTo2xMs: 360000,
      bucketCoverage: 42,
    });
  });

  it('queries only recent PumpFun migrated rows with bounded runtime options', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [{
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'FAST',
          name: 'Fast Token',
          source: 'pumpfun-migrated',
          migration_started_at: '2026-04-27T10:00:00.000Z',
          migration_age_ms: '300000',
          first_mcap: '22000',
          current_mcap: '50000',
          p95_mcap_recent: '48000',
          p95_vol_5m_recent: '65000',
          avg_vol_5m_first_30m: '51000',
          time_to_2x_ms: '240000',
          mcap_buckets: '24',
          vol_buckets: '22',
        }],
      };
    };

    try {
      const rows = await pumpfunFast5xCandidates.listPumpfunFast5xCandidates({
        now: '2026-04-27T10:15:00.000Z',
        limit: 25,
        maxMigrationAgeMs: 45 * 60 * 1000,
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0].signalInput.firstMcap, 22000);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /source = 'pumpfun-migrated'/);
      assert.match(calls[0].sql, /LIMIT \$3::int/);
      assert.deepEqual(calls[0].params, [
        10 * 60 * 1000,
        45 * 60 * 1000,
        25,
        '2026-04-27T10:15:00.000Z',
      ]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('caps candidate limit to avoid accidental large runtime scans', () => {
    const options = pumpfunFast5xCandidates.__private.resolveOptions({
      limit: 5000,
      maxMigrationAgeMs: 0,
      migrationGraceMs: 0,
      now: 'bad-date',
    });

    assert.equal(options.limit, 500);
    assert.equal(options.maxMigrationAgeMs, 60 * 60 * 1000);
    assert.equal(options.migrationGraceMs, 10 * 60 * 1000);
    assert.ok(options.now instanceof Date);
  });
});
