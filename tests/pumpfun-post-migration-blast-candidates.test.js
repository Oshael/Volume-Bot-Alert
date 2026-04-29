const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const candidates = require('../src/services/pumpfun-post-migration-blast-candidates');

describe('PumpFun post-migration blast candidates', () => {
  it('maps database rows into signal input for the pure classifier', () => {
    const mapped = candidates.__private.mapCandidateRow({
      address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
      symbol: 'BLAST',
      name: 'Blast Token',
      source: 'pumpfun-migrated',
      migration_started_at: '2026-04-29T00:18:00.000Z',
      current_bucket_at: '2026-04-29T00:21:00.000Z',
      migration_age_ms: '180000',
      first_mcap: '12355.64',
      current_mcap: '55767',
      high_mcap_recent: '75588',
      max_vol_5m_recent: '124518.57',
      p95_vol_5m_recent: '120000',
      time_to_high_mcap_ms: '180000',
      mcap_buckets: '4',
      vol_buckets: '4',
    });

    assert.equal(mapped.address, '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy');
    assert.equal(mapped.signalInput.source, 'pumpfun-migrated');
    assert.equal(mapped.signalInput.firstMcap, 12355.64);
    assert.equal(mapped.signalInput.highMcapRecent, 75588);
    assert.equal(mapped.signalInput.maxVol5mRecent, 124518.57);
    assert.equal(mapped.signalInput.timeToHighMcapMs, 180000);
    assert.equal(mapped.signalInput.bucketCoverage, 4);
    assert.equal(mapped.volumeBucketCount, 4);
  });

  it('queries recent PumpFun migrated rows with bounded runtime options', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [{
          address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
          source: 'pumpfun-migrated',
          first_mcap: '12355.64',
          high_mcap_recent: '75588',
          max_vol_5m_recent: '124518.57',
          time_to_high_mcap_ms: '180000',
          mcap_buckets: '4',
        }],
      };
    };

    try {
      const result = await candidates.listPumpfunPostMigrationBlastCandidates({
        migrationGraceMs: 10 * 60 * 1000,
        maxMigrationAgeMs: 20 * 60 * 1000,
        minHighMcapRecent: 75_000,
        limit: 42,
        now: '2026-04-29T00:21:00.000Z',
      });

      assert.equal(result.length, 1);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /source = 'pumpfun-migrated'/);
      assert.match(calls[0].sql, /mb\.source IN \('pumpfun-migrated', 'dexscreener'\)/);
      assert.deepEqual(calls[0].params, [
        10 * 60 * 1000,
        20 * 60 * 1000,
        42,
        '2026-04-29T00:21:00.000Z',
        75_000,
      ]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('caps candidate limit to avoid accidental large runtime scans', () => {
    const options = candidates.__private.resolveOptions({
      limit: 5000,
      migrationGraceMs: 0,
      maxMigrationAgeMs: 0,
      minHighMcapRecent: 0,
    });

    assert.equal(options.limit, 500);
    assert.equal(options.migrationGraceMs, 10 * 60 * 1000);
    assert.equal(options.maxMigrationAgeMs, 20 * 60 * 1000);
    assert.equal(options.minHighMcapRecent, 75_000);
  });
});
