const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const candidates = require('../src/services/pumpfun-combo-confirmation-candidates');

describe('PumpFun combo confirmation candidates', () => {
  it('maps Blast and Fast persisted detections into combo signal input', () => {
    const mapped = candidates.__private.mapCandidateRow({
      address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
      symbol: 'COMBO',
      name: 'Combo Token',
      migration_started_at: '2026-04-29T00:18:00.000Z',
      blast_alert_triggered_at: '2026-04-29T00:21:00.000Z',
      blast_alert_mcap: '80500',
      blast_score: '135.5',
      blast_evidence_at_alert: {
        timeToHighMcapMs: 180000,
        highMcapRecent: 100000,
        strongestVol5m: 125000,
      },
      fast_alert_triggered_at: '2026-04-29T00:31:00.000Z',
      fast_alert_mcap: '97000',
      fast_score: '144.2',
      fast_evidence_at_alert: {
        timeTo2xMs: 360000,
      },
      pre_buckets: '4',
      pre_high_mcap: '29000',
      max_pre_vol_5m: '22000',
    });

    assert.equal(mapped.address, '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy');
    assert.equal(mapped.signalInput.blastAlertMcap, 80500);
    assert.equal(mapped.signalInput.hasFastConfirmation, true);
    assert.equal(mapped.signalInput.fastConfirmationDelayMs, 10 * 60 * 1000);
    assert.equal(mapped.signalInput.preHighMcap, 29000);
  });

  it('queries persisted Blast detections with bounded combo options', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [{
          address: '12eM87tTACWpgnwuapFUHDVDXFaZSxJqxBNj1AHB56sy',
          blast_alert_mcap: '80500',
          blast_score: '135.5',
          blast_evidence_at_alert: { timeToHighMcapMs: 180000 },
        }],
      };
    };

    try {
      const result = await candidates.listPumpfunComboConfirmationCandidates({
        maxDetectionAgeMs: 12 * 60 * 60 * 1000,
        minBlastAlertMcap: 50_000,
        maxBlastAlertMcap: 100_000,
        limit: 42,
        now: '2026-04-29T12:00:00.000Z',
      });

      assert.equal(result.length, 1);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /FROM pumpfun_post_migration_blast_detections b/);
      assert.match(calls[0].sql, /LEFT JOIN pumpfun_fast_5x_detections f/);
      assert.deepEqual(calls[0].params, [
        '2026-04-29T12:00:00.000Z',
        12 * 60 * 60 * 1000,
        50_000,
        100_000,
        42,
      ]);
    } finally {
      db.query = originalQuery;
    }
  });
});
