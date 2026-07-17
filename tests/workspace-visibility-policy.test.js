const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_CHAIN_POLICIES,
  DEFAULT_FRESH_MS,
  evaluateWorkspaceVisibility,
  normalizeValuationFilters,
} = require('../src/services/workspace-visibility-policy');

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const NOW_MS = Date.UTC(2026, 6, 15, 12, 0, 0);

function evaluate(input = {}, options = {}) {
  return evaluateWorkspaceVisibility({
    identity: { chain: 'solana', address: SOLANA },
    ...input,
  }, {
    nowMs: NOW_MS,
    ...options,
  });
}

describe('workspace visibility policy', () => {
  it('keeps permanent exclusions separate from legacy lifecycle state', () => {
    const cases = [
      {
        name: 'authoritative admin block',
        state: { adminBlocked: true, eligibleForMonitoring: true },
        visible: false,
        reasons: ['admin_blocked'],
        riskState: 'blocked',
      },
      {
        name: 'per-user block',
        state: { userBlocked: true, eligibleForMonitoring: true },
        visible: false,
        reasons: ['user_blocked'],
        riskState: 'unknown',
      },
      {
        name: 'chain-native permanent safety block',
        state: { chainSafetyBlocked: true },
        visible: false,
        reasons: ['chain_safety_excluded'],
        riskState: 'rejected',
      },
      {
        name: 'manual permanent junk review',
        state: { riskReviewSource: 'manual', riskReviewLabel: 'junk_permanent' },
        visible: false,
        reasons: ['risk_junk_permanent'],
        riskState: 'rejected',
      },
      {
        name: 'probable junk awaiting review',
        state: { riskReviewSource: 'auto', riskReviewLabel: 'junk_probable' },
        visible: true,
        reasons: [],
        riskState: 'review',
      },
      {
        name: 'manual valid review',
        state: { riskReviewSource: 'manual', riskReviewLabel: 'valid' },
        visible: true,
        reasons: [],
        riskState: 'approved',
      },
      {
        name: 'weak but valid review',
        state: { riskReviewSource: 'auto', riskReviewLabel: 'valid_but_weak' },
        visible: true,
        reasons: [],
        riskState: 'caution',
      },
      {
        name: 'stale legacy admin mirror without authoritative relation',
        state: {
          eligibilityState: 'admin-blocked',
          suppressedReason: 'admin_blocked',
          eligibleForMonitoring: false,
        },
        visible: true,
        reasons: [],
        riskState: 'unknown',
      },
      {
        name: 'Solana low activity',
        state: {
          eligibilityState: 'gmgn-low-activity',
          suppressedReason: 'low_activity_24h',
          eligibleForMonitoring: false,
          riskState: 'approved',
        },
        visible: true,
        reasons: [],
        riskState: 'approved',
        activityState: 'stale',
      },
      {
        name: 'cleanup archive',
        state: {
          suppressedReason: 'cleanup_soft_archive',
          eligibleForMonitoring: false,
        },
        visible: true,
        reasons: [],
        riskState: 'unknown',
      },
    ];

    for (const testCase of cases) {
      const result = evaluate({ state: testCase.state });
      assert.equal(result.visible, testCase.visible, testCase.name);
      assert.deepEqual(result.reasons, testCase.reasons, testCase.name);
      assert.equal(result.riskState, testCase.riskState, testCase.name);
      assert.equal(result.activityState, testCase.activityState || 'unknown', testCase.name);
    }
  });

  it('uses observation time before legacy activity reasons', () => {
    const result = evaluate({
      identity: { chain: 'robinhood', address: EVM },
      state: {
        suppressedReason: 'robinhood-no-swaps-15m',
        lastActivityAt: new Date(NOW_MS - 60_000).toISOString(),
      },
    });

    assert.equal(result.visible, true);
    assert.equal(result.activityState, 'fresh');

    const withoutObservation = evaluate({
      identity: { chain: 'robinhood', address: EVM },
      state: { suppressedReason: 'robinhood-no-swaps-15m' },
    });
    assert.equal(withoutObservation.visible, true);
    assert.equal(withoutObservation.activityState, 'stale');
  });

  it('does not apply Solana-only permanent review rules to Robinhood', () => {
    const result = evaluate({
      identity: { chain: 'robinhood', address: EVM },
      state: { riskReviewSource: 'manual', riskReviewLabel: 'junk_permanent' },
    });

    assert.equal(result.visible, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.riskState, 'unknown');
  });

  it('normalizes chain-native valuation without copying MCAP and FDV', () => {
    const cases = [
      {
        name: 'fresh Solana market cap',
        identity: { chain: 'solana', address: SOLANA },
        valuation: {
          type: 'mcap',
          usd: 45_000,
          observedAt: new Date(NOW_MS - 60_000).toISOString(),
        },
        type: 'mcap',
        freshness: 'fresh',
      },
      {
        name: 'stale Robinhood FDV',
        identity: { chain: 'robinhood', address: EVM },
        valuation: {
          type: 'fdv',
          usd: 52_000,
          observedAt: new Date(NOW_MS - DEFAULT_FRESH_MS - 1).toISOString(),
        },
        type: 'fdv',
        freshness: 'stale',
      },
    ];

    for (const testCase of cases) {
      const result = evaluate({
        identity: testCase.identity,
        valuation: testCase.valuation,
        filters: { minValuationUsd: 30_000 },
      });
      assert.equal(result.visible, true, testCase.name);
      assert.equal(result.valuation.type, testCase.type, testCase.name);
      assert.equal(result.valuation.usd, testCase.valuation.usd, testCase.name);
      assert.equal(result.valuation.freshness, testCase.freshness, testCase.name);
      assert.deepEqual(result.dataQuality, [], testCase.name);
    }

    const wrongType = evaluate({
      identity: { chain: 'robinhood', address: EVM },
      valuation: {
        type: 'mcap',
        usd: 52_000,
        observedAt: new Date(NOW_MS - 60_000).toISOString(),
      },
      filters: { minValuationUsd: 30_000 },
    });
    assert.equal(wrongType.valuation.type, 'fdv');
    assert.equal(wrongType.valuation.usd, null);
    assert.deepEqual(wrongType.dataQuality, ['valuation_type_mismatch']);
    assert.deepEqual(wrongType.filterMismatch, ['valuation_unavailable']);
  });

  it('marks valuation freshness boundaries and incomplete observations honestly', () => {
    const cases = [
      { ageMs: DEFAULT_FRESH_MS, freshness: 'fresh', issues: [] },
      { ageMs: DEFAULT_FRESH_MS + 1, freshness: 'stale', issues: [] },
      {
        ageMs: null,
        freshness: 'unknown',
        issues: ['valuation_observed_at_missing'],
      },
      {
        ageMs: -1,
        freshness: 'unknown',
        issues: ['valuation_observed_at_future'],
      },
    ];

    for (const testCase of cases) {
      const result = evaluate({
        valuation: {
          type: 'mcap',
          usd: 30_000,
          observedAt: testCase.ageMs == null
            ? null
            : new Date(NOW_MS - testCase.ageMs).toISOString(),
        },
      });
      assert.equal(result.valuation.freshness, testCase.freshness);
      assert.deepEqual(result.dataQuality, testCase.issues);
    }
  });

  it('makes valuation filters reversible without mutating input state', () => {
    const state = Object.freeze({
      eligibleForMonitoring: false,
      suppressedReason: 'low_activity_24h',
    });
    const valuation = Object.freeze({
      type: 'mcap',
      usd: 25_000,
      observedAt: new Date(NOW_MS - 60_000).toISOString(),
    });

    const hidden = evaluate({
      state,
      valuation,
      filters: { minValuationUsd: 30_000 },
    });
    const restored = evaluate({
      state,
      valuation,
      filters: { minValuationUsd: 20_000 },
    });

    assert.equal(hidden.visible, false);
    assert.deepEqual(hidden.reasons, []);
    assert.deepEqual(hidden.filterMismatch, ['valuation_below_min']);
    assert.equal(restored.visible, true);
    assert.deepEqual(evaluate({
      valuation,
      filters: { maxValuationUsd: 20_000 },
    }).filterMismatch, ['valuation_above_max']);
    assert.deepEqual(state, {
      eligibleForMonitoring: false,
      suppressedReason: 'low_activity_24h',
    });
  });

  it('keeps known future chains unavailable until their adapters are supplied', () => {
    const disabledRobinhood = evaluate({
      identity: { chain: 'robinhood', address: EVM },
    }, { availableChains: ['solana'] });
    assert.deepEqual(disabledRobinhood.reasons, ['unsupported_workspace_chain']);

    const unavailable = evaluate({ identity: { chain: 'bsc', address: EVM } });
    assert.equal(unavailable.visible, false);
    assert.equal(unavailable.identity.chain, 'bsc');
    assert.deepEqual(unavailable.reasons, ['unsupported_workspace_chain']);

    const chainPolicies = {
      ...DEFAULT_CHAIN_POLICIES,
      bsc: { valuationTypes: ['mcap', 'fdv'], hardRiskReviews: [] },
    };
    const available = evaluate({
      identity: { chain: 'bsc', address: EVM },
      valuation: {
        type: 'mcap',
        usd: 40_000,
        observedAt: new Date(NOW_MS).toISOString(),
      },
      filters: { minValuationUsd: 30_000 },
    }, {
      chainPolicies,
      availableChains: ['solana', 'robinhood', 'bsc'],
    });
    assert.equal(available.visible, true);
    assert.equal(available.valuation.type, 'mcap');
  });

  it('rejects malformed identities and contradictory filter ranges', () => {
    assert.deepEqual(
      evaluate({ identity: { chain: 'robinhood', address: SOLANA } }).reasons,
      ['invalid_identity'],
    );
    assert.deepEqual(
      evaluate({ identity: { chain: 'unknown', address: EVM } }).reasons,
      ['unsupported_identity_chain'],
    );
    assert.throws(
      () => normalizeValuationFilters({ minValuationUsd: 50_000, maxValuationUsd: 30_000 }),
      /greater than or equal/,
    );
  });
});
