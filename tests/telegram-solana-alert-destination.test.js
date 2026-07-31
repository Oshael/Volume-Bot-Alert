const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildDefaultRules,
} = require('../src/services/telegram-alert-rule-contracts');
const {
  createTelegramSolanaAlertDestination,
} = require('../src/services/telegram-solana-alert-destination');

const TOKEN = '11111111111111111111111111111111';
const UNUSED_PLANNER = Object.freeze({
  async plan() {
    throw new Error('Planner should not be called during profile discovery');
  },
});

function candidate() {
  const profile = {
    id: '10',
    connection_id: '20',
    user_id: 7,
    chain: 'solana',
    enabled: true,
    sparkline_enabled: true,
    version: 3,
    updated_at: '2026-07-29T15:00:00.000Z',
  };
  return {
    profile,
    rules: buildDefaultRules('solana').map((rule, index) => ({
      profile_id: profile.id,
      chain: 'solana',
      rule_key: rule.ruleKey,
      enabled: rule.ruleKey === 'monitored-vol',
      settings_json: rule.settings,
      version: index + 1,
      updated_at: `2026-07-29T15:0${index}:00.000Z`,
    })),
  };
}

describe('Telegram Solana alert destination', () => {
  it('does no discovery or evaluation while explicitly disabled', async () => {
    let sourceCalls = 0;
    const destination = createTelegramSolanaAlertDestination({
      enabled: false,
      profileSource: {
        async listEligible() {
          sourceCalls += 1;
          return [candidate()];
        },
      },
    });

    assert.deepEqual(await destination.listSignalProfiles({ nowMs: 1 }), []);
    assert.deepEqual(await destination.evaluate({}), {
      evaluated: 0,
      committed: 0,
      duplicate: 0,
      deliveries: 0,
      errors: 0,
    });
    assert.equal(sourceCalls, 0);
  });

  it('adapts eligible profiles with signal demand independent from dashboard', async () => {
    const calls = [];
    const destination = createTelegramSolanaAlertDestination({
      enabled: true,
      planner: UNUSED_PLANNER,
      profileSource: {
        async listEligible(input) {
          calls.push(input);
          return [candidate()];
        },
      },
    });

    const profiles = await destination.listSignalProfiles({ nowMs: 123 });

    assert.deepEqual(calls, [{ chain: 'solana', nowMs: 123 }]);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].destination, 'telegram');
    assert.equal(profiles[0].ruleEnabled.monitoredVol, true);
    assert.equal(profiles[0].ruleEnabled.monitoredMcap, false);
  });

  it('loads state, plans and commits each profile while isolating failures', async () => {
    const first = (await createTelegramSolanaAlertDestination({
      enabled: true,
      planner: UNUSED_PLANNER,
      profileSource: { async listEligible() { return [candidate()]; } },
    }).listSignalProfiles())[0];
    const failing = Object.freeze({ ...first, profileId: '11' });
    const calls = [];
    const errors = [];
    const signals = { currentVolume5m: 20_000 };
    const destination = createTelegramSolanaAlertDestination({
      enabled: true,
      profileSource: { async listEligible() { return []; } },
      stateModel: {
        async listByProfileAndToken(input) {
          calls.push(['states', input]);
          return [{ profileId: input.profileId }];
        },
      },
      planner: {
        async plan(input) {
          calls.push(['plan', input]);
          if (input.profile.profileId === '11') throw new Error('bad profile');
          return {
            profileId: input.profile.profileId,
            connectionId: input.profile.connectionId,
            intents: [],
            stateTransitions: [],
          };
        },
      },
      committer: {
        async commit(input) {
          calls.push(['commit', input]);
          return { deliveries: [{ id: '41' }], duplicate: false };
        },
      },
      async onProfileError(input) {
        errors.push(input);
      },
    });

    const result = await destination.evaluate({
      profiles: [first, failing],
      tokenAfter: { address: TOKEN },
      signals,
      nowMs: 456,
    });

    assert.equal(result.evaluated, 2);
    assert.equal(result.committed, 1);
    assert.equal(result.deliveries, 1);
    assert.equal(result.errors, 1);
    assert.equal(errors[0].phase, 'profile-evaluation');
    const planned = calls.find(([name]) => name === 'plan')[1];
    assert.equal(planned.signals, signals);
    assert.equal(planned.states[0].profileId, '10');
    assert.equal(calls.filter(([name]) => name === 'commit').length, 1);
  });
});
