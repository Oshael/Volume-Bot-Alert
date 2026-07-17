const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const monitoredTokenExitEvent = require('../src/models/monitored-token-exit-event');

const {
  buildSnapshot,
  isLegacySignalEligible,
  mapRow,
  normalizeEventDetails,
  normalizeJsonObject,
  resolveExitReason,
} = monitoredTokenExitEvent.__private;

describe('monitored token exit event helpers', () => {
  it('matches the frozen legacy Solana signal-eligibility rule', () => {
    assert.equal(isLegacySignalEligible({ eligible_for_monitoring: true, last_mcap: 30000 }), true);
    assert.equal(isLegacySignalEligible({ eligible_for_monitoring: true, last_mcap: 29999 }), false);
    assert.equal(isLegacySignalEligible({ eligible_for_monitoring: false, last_mcap: 50000 }), false);
    assert.equal(isLegacySignalEligible(null), false);
  });

  it('resolves the stored exit reason from the current catalog state', () => {
    const previous = { eligible_for_monitoring: true, last_mcap: 45000 };

    assert.equal(resolveExitReason(previous, {
      eligible_for_monitoring: false,
      suppressed_reason: 'low_activity_24h',
      eligibility_state: 'dex-low-activity',
      last_mcap: 44000,
    }), 'low_activity_24h');

    assert.equal(resolveExitReason(previous, {
      eligible_for_monitoring: false,
      suppressed_reason: null,
      eligibility_state: 'dex_pair_missing',
      last_mcap: 44000,
    }), 'dex_pair_missing');

    assert.equal(resolveExitReason(previous, {
      eligible_for_monitoring: true,
      suppressed_reason: null,
      eligibility_state: 'dex-normal',
      last_mcap: 24000,
    }), 'mcap_below_monitored_min');
  });

  it('builds compact before and after snapshots for inspection', () => {
    assert.deepEqual(buildSnapshot({
      address: 'So11111111111111111111111111111111111111112',
      chain: 'solana',
      source: 'gmgn',
      eligibility_state: 'dex-low-activity',
      eligible_for_monitoring: false,
      suppressed_reason: 'low_activity_24h',
      is_active_monitor_candidate: true,
      monitor_priority: 'dormant',
      last_mcap: '42000.5',
      last_liquidity_usd: '1200',
      last_vol_5m: '10',
      last_vol_24h: '900',
      evaluation_error_count: '2',
    }), {
      address: 'So11111111111111111111111111111111111111112',
      chain: 'solana',
      source: 'gmgn',
      eligibilityState: 'dex-low-activity',
      eligibleForMonitoring: false,
      suppressedReason: 'low_activity_24h',
      activeMonitorCandidate: true,
      monitorPriority: 'dormant',
      mcap: 42000.5,
      liquidityUsd: 1200,
      volume5m: 10,
      volume1h: null,
      volume6h: null,
      volume24h: 900,
      lastSeenAt: null,
      lastEvaluatedAt: null,
      nextEvaluationAt: null,
      evaluationErrorCount: 2,
      lastEvaluationError: null,
    });
  });

  it('maps rows to the API shape and normalizes JSON objects', () => {
    assert.deepEqual(normalizeJsonObject(['bad']), {});
    assert.deepEqual(normalizeEventDetails({ workspaceExit: true, pipeline: 'catalog' }), {
      pipeline: 'catalog',
      semanticVersion: 1,
      scope: 'legacy-signal-eligibility',
      workspaceExit: false,
    });
    assert.deepEqual(mapRow({
      id: '9',
      chain: 'solana',
      token_address: 'So11111111111111111111111111111111111111112',
      exit_reason: 'mcap_below_monitored_min',
      exit_source: 'dexscreener',
      previous_snapshot: { mcap: 35000 },
      current_snapshot: { mcap: 25000 },
      details: { minMcap: 30000 },
      created_at: '2026-05-17T10:00:00.000Z',
    }), {
      id: 9,
      chain: 'solana',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      exitReason: 'mcap_below_monitored_min',
      exitSource: 'dexscreener',
      previousSnapshot: { mcap: 35000 },
      currentSnapshot: { mcap: 25000 },
      details: { minMcap: 30000 },
      createdAt: '2026-05-17T10:00:00.000Z',
      semantics: {
        version: 1,
        scope: 'legacy-signal-eligibility',
        workspaceExit: false,
      },
    });
  });

  it('keeps Robinhood exit detection disabled until its eligibility rules exist', async () => {
    await assert.rejects(
      () => monitoredTokenExitEvent.createEvent({
        chain: 'robinhood',
        tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
        exitReason: 'test',
      }),
      (error) => error.code === 'NON_SOLANA_EXIT_EVENT_DISABLED'
    );
  });
});
