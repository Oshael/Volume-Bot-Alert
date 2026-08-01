const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  adaptTelegramAlertEvaluationProfile,
} = require('../src/services/telegram-alert-evaluation-profile');
const {
  buildDefaultRules,
} = require('../src/services/telegram-alert-rule-contracts');
const {
  createTelegramSolanaAlertPlanner,
} = require('../src/services/telegram-solana-alert-planner');
const {
  evaluateSolanaAlertProfile,
} = require('../src/services/user-alert-matcher');

const TOKEN_ADDRESS = '11111111111111111111111111111111';
const NOW_MS = Date.UTC(2026, 6, 29, 15, 0, 0);

function profileFixture(reactivation) {
  const profile = {
    id: '9007199254740993',
    connection_id: '9007199254740995',
    user_id: 7,
    chain: 'solana',
    enabled: true,
    sparkline_enabled: true,
    version: 3,
    updated_at: '2026-07-29T14:00:00.000Z',
  };
  const rules = buildDefaultRules('solana').map((rule, index) => ({
    profile_id: profile.id,
    chain: 'solana',
    rule_key: rule.ruleKey,
    enabled: rule.ruleKey === 'monitored-vol',
    settings_json: rule.ruleKey === 'monitored-vol'
      ? { ...rule.settings, cooldownMinutes: 10 }
      : rule.settings,
    version: index + 2,
    updated_at: `2026-07-29T14:0${index}:00.000Z`,
  }));
  return adaptTelegramAlertEvaluationProfile({ profile, reactivation, rules });
}

function signals() {
  return {
    hasVol5mBaseline: true,
    vol5mChangePct: 100,
    prevVolume5m: 10_000,
    currentVolume5m: 20_000,
    currentVolume1m: null,
    prevVolume1m: null,
    currentMcap: 100_000,
    prevMcap: 90_000,
    volume24h: 200_000,
    isMcapDeclining: false,
  };
}

function stateRow(profile, ruleVersion) {
  return {
    profileId: profile.profileId,
    chain: 'solana',
    ruleKey: 'monitored-vol',
    tokenAddress: TOKEN_ADDRESS,
    ruleVersion,
    state: {
      status: 'triggered',
      lastAlertedAt: new Date(NOW_MS - 1_000).toISOString(),
      lastAlertedValue: 10_000,
      lastAlertedPct: 50,
      cooldownUntil: new Date(NOW_MS + 60_000).toISOString(),
      rearmRequired: true,
      lastFingerprint: 'previous',
      metadata: { lastDecision: 'triggered' },
    },
    version: 5,
  };
}

function createPlanner() {
  return createTelegramSolanaAlertPlanner({
    evaluateProfile: evaluateSolanaAlertProfile,
  });
}

describe('Telegram Solana alert planner', () => {
  it('plans a durable intent and next state without writing either one', async () => {
    const profile = profileFixture();
    const planner = createPlanner();

    const result = await planner.plan({
      profile,
      states: [],
      tokenAfter: { address: TOKEN_ADDRESS, symbol: 'PLAN' },
      signals: signals(),
      nowMs: NOW_MS,
    });

    assert.equal(result.intents.length, 1);
    assert.equal(result.intents[0].profileId, profile.profileId);
    assert.equal(result.intents[0].connectionId, profile.connectionId);
    assert.equal(result.intents[0].ruleKey, 'monitored-vol');
    assert.match(result.intents[0].dedupeKey, new RegExp(`^profile:${profile.profileId}:`));
    assert.equal(result.stateTransitions.length, 1);
    assert.equal(result.stateTransitions[0].expectedVersion, null);
    assert.equal(result.stateTransitions[0].state.status, 'triggered');
    assert.equal(
      result.stateTransitions[0].state.cooldownUntil,
      new Date(NOW_MS + 10 * 60 * 1000).toISOString()
    );
    assert.deepEqual(result.stateTransitions[0].eventReferences, [{
      field: 'metadata.lastEventId',
      intentRef: result.intents[0].intentRef,
    }]);
  });

  it('uses matching rule state for cooldown but resets state from an older rule version', async () => {
    const profile = profileFixture();
    const ruleVersion = profile.rules.find(
      (rule) => rule.ruleKey === 'monitored-vol'
    ).version;
    const planner = createPlanner();

    const suppressed = await planner.plan({
      profile,
      states: [stateRow(profile, ruleVersion)],
      tokenAfter: { address: TOKEN_ADDRESS, symbol: 'PLAN' },
      signals: signals(),
      nowMs: NOW_MS,
    });
    assert.equal(suppressed.intents.length, 0);

    const reset = await planner.plan({
      profile,
      states: [stateRow(profile, ruleVersion - 1)],
      tokenAfter: { address: TOKEN_ADDRESS, symbol: 'PLAN' },
      signals: signals(),
      nowMs: NOW_MS,
    });
    assert.equal(reset.intents.length, 1);
    assert.equal(reset.stateTransitions[0].expectedVersion, 5);
    assert.equal(reset.stateTransitions[0].ruleVersion, ruleVersion);
  });

  it('turns a pending reactivation observation into state-only baseline', async () => {
    const requestedAt = '2026-07-29T14:30:00.000Z';
    const profile = profileFixture({
      status: 'access_suspended', requested_at: requestedAt, reactivated_at: null,
    });
    const result = await createPlanner().plan({
      profile,
      states: [],
      tokenAfter: { address: TOKEN_ADDRESS, symbol: 'PLAN' },
      signals: signals(),
      nowMs: NOW_MS,
    });

    assert.equal(result.intents.length, 0);
    assert.equal(result.stateTransitions.length, 1);
    assert.equal(result.stateTransitions[0].state.status, 'triggered');
    assert.equal(
      result.stateTransitions[0].state.metadata.lastDecision,
      'reactivation_baseline',
    );
    assert.deepEqual(result.stateTransitions[0].eventReferences, []);
    assert.deepEqual(result.reactivationBaseline, {
      epoch: requestedAt, pending: true, requestedAt,
    });
    assert.equal(result.summary.emitted, 0);
  });

  it('lazily baselines old tokens but allows tokens created after reactivation', async () => {
    const reactivatedAt = '2026-07-29T14:30:00.000Z';
    const profile = profileFixture({
      status: 'active', requested_at: null, reactivated_at: reactivatedAt,
    });
    const planner = createPlanner();
    const oldToken = await planner.plan({
      profile,
      states: [],
      tokenAfter: { address: TOKEN_ADDRESS, last_token_created_at_ms: NOW_MS - 60 * 60 * 1000 },
      signals: signals(),
      nowMs: NOW_MS,
    });
    const newToken = await planner.plan({
      profile,
      states: [],
      tokenAfter: { address: TOKEN_ADDRESS, last_token_created_at_ms: NOW_MS - 10 * 60 * 1000 },
      signals: signals(),
      nowMs: NOW_MS,
    });
    const baselineTransition = oldToken.stateTransitions[0];
    const afterBaseline = await planner.plan({
      profile,
      states: [{
        profileId: profile.profileId,
        chain: profile.chain,
        ruleKey: baselineTransition.ruleKey,
        tokenAddress: TOKEN_ADDRESS,
        ruleVersion: baselineTransition.ruleVersion,
        state: baselineTransition.state,
        version: 1,
        updatedAt: reactivatedAt,
      }],
      tokenAfter: { address: TOKEN_ADDRESS, last_token_created_at_ms: NOW_MS - 60 * 60 * 1000 },
      signals: signals(),
      nowMs: NOW_MS,
    });

    assert.equal(oldToken.intents.length, 0);
    assert.equal(oldToken.reactivationBaseline.pending, false);
    assert.equal(newToken.intents.length, 1);
    assert.equal(newToken.reactivationBaseline, undefined);
    assert.equal(afterBaseline.reactivationBaseline, undefined);
  });

  it('does not evaluate a disabled destination profile', async () => {
    const profile = Object.freeze({ ...profileFixture(), enabled: false });
    let evaluations = 0;
    const planner = createTelegramSolanaAlertPlanner({
      async evaluateProfile() {
        evaluations += 1;
      },
    });

    const result = await planner.plan({
      profile,
      states: [],
      tokenAfter: { address: TOKEN_ADDRESS },
      signals: signals(),
      nowMs: NOW_MS,
    });

    assert.equal(evaluations, 0);
    assert.equal(result.intents.length, 0);
    assert.equal(result.stateTransitions.length, 0);
  });

  it('requires the matcher evaluator through an explicit port', () => {
    assert.throws(
      () => createTelegramSolanaAlertPlanner(),
      /profile evaluator port is required/
    );
  });
});
