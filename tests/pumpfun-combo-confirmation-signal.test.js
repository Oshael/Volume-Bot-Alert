const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_OPTIONS,
  evaluatePumpfunComboConfirmationSignal,
} = require('../src/services/pumpfun-combo-confirmation-signal');

function buildSignal(overrides = {}) {
  return {
    blastAlertMcap: 80_000,
    blastScore: 135,
    blastTimeToHighMcapMs: 3 * 60 * 1000,
    blastHighMcapRecent: 110_000,
    blastStrongestVol5m: 130_000,
    hasFastConfirmation: false,
    preBuckets: 3,
    preHighMcap: 28_000,
    maxPreVol5m: 22_000,
    ...overrides,
  };
}

describe('PumpFun combo confirmation signal', () => {
  it('passes a Blast candidate inside the observed combo band', () => {
    const result = evaluatePumpfunComboConfirmationSignal(buildSignal());

    assert.equal(result.passes, true);
    assert.equal(result.reason, 'blast_core');
    assert.equal(result.evidence.ruleKey, 'pumpfun-combo-confirmation');
    assert.equal(result.evidence.blastAlertMcap, 80_000);
    assert.equal(result.evidence.hasFastConfirmation, false);
  });

  it('marks Fast 5x overlap as a confirmation reason', () => {
    const result = evaluatePumpfunComboConfirmationSignal(buildSignal({
      hasFastConfirmation: true,
      fastConfirmationDelayMs: 12 * 60 * 1000,
      fastAlertMcap: 95_000,
      fastScore: 145,
    }));

    assert.equal(result.passes, true);
    assert.equal(result.reason, 'blast_with_fast_confirmation');
    assert.equal(result.evidence.fastConfirmationDelayMinutes, 12);
    assert.equal(result.score > evaluatePumpfunComboConfirmationSignal(buildSignal()).score, true);
  });

  it('rejects candidates outside the Blast alert market-cap band', () => {
    assert.equal(
      evaluatePumpfunComboConfirmationSignal(buildSignal({ blastAlertMcap: 40_000 })).reason,
      'blast_alert_mcap_below_combo_band'
    );
    assert.equal(
      evaluatePumpfunComboConfirmationSignal(buildSignal({ blastAlertMcap: 120_000 })).reason,
      'blast_alert_mcap_above_combo_band'
    );
  });

  it('rejects weak or slow Blast confirmations', () => {
    assert.equal(
      evaluatePumpfunComboConfirmationSignal(buildSignal({ blastScore: 90 })).reason,
      'blast_score_below_combo_min'
    );
    assert.equal(
      evaluatePumpfunComboConfirmationSignal(buildSignal({
        blastTimeToHighMcapMs: DEFAULT_OPTIONS.maxBlastTimeToHighMcapMs + 1,
      })).reason,
      'blast_time_to_high_mcap_too_slow'
    );
  });

  it('rejects impossible Fast confirmation timing', () => {
    const result = evaluatePumpfunComboConfirmationSignal(buildSignal({
      hasFastConfirmation: true,
      fastConfirmationDelayMs: -60_000,
    }));

    assert.equal(result.passes, false);
    assert.equal(result.reason, 'fast_confirmation_before_blast');
  });
});
