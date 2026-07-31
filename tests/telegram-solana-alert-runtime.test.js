const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildDefaultRules,
} = require('../src/services/telegram-alert-rule-contracts');
const {
  createTelegramSolanaAlertRuntime,
} = require('../src/services/telegram-solana-alert-runtime');

function candidate() {
  const profile = {
    id: '10',
    user_id: 7,
    connection_id: '20',
    chain: 'solana',
    enabled: true,
    sparkline_enabled: true,
    version: 1,
    updated_at: '2026-07-29T20:00:00.000Z',
  };
  return {
    profile,
    user: {
      id: 7,
      role: 'user',
      is_active: true,
      access_status: 'active',
    },
    rules: buildDefaultRules('solana').map((rule) => ({
      profile_id: profile.id,
      chain: profile.chain,
      rule_key: rule.ruleKey,
      enabled: rule.ruleKey === 'monitored-vol',
      settings_json: rule.settings,
      version: 1,
      updated_at: '2026-07-29T20:00:00.000Z',
    })),
  };
}

async function unusedEvaluator() {
  throw new Error('Evaluator should not be called during profile discovery');
}

describe('Telegram Solana alert runtime composition', () => {
  it('keeps profile discovery closed without the explicit rollout flag', async () => {
    let repositoryCalls = 0;
    const runtime = createTelegramSolanaAlertRuntime({
      enabled: false,
      evaluateProfile: unusedEvaluator,
      profileSourceOptions: {
        candidateModel: {
          async listByChain() {
            repositoryCalls += 1;
            return [candidate()];
          },
        },
        async accessResolver() {
          return { hasProductAccess: true };
        },
      },
    });

    const profiles = await runtime.destination.listSignalProfiles();

    assert.deepEqual(profiles, []);
    assert.equal(repositoryCalls, 0);
  });

  it('composes the eligible source and injected evaluator when enabled', async () => {
    const accessCalls = [];
    const runtime = createTelegramSolanaAlertRuntime({
      enabled: true,
      evaluateProfile: unusedEvaluator,
      profileSourceOptions: {
        candidateModel: {
          async listByChain(chain) {
            assert.equal(chain, 'solana');
            return [candidate()];
          },
        },
        async accessResolver(user) {
          accessCalls.push(user.id);
          return { hasProductAccess: true };
        },
      },
    });

    const profiles = await runtime.destination.listSignalProfiles({
      nowMs: Date.UTC(2026, 6, 29, 20),
    });

    assert.deepEqual(accessCalls, [7]);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].destination, 'telegram');
    assert.equal(profiles[0].profileId, '10');
    assert.equal(profiles[0].ruleEnabled.monitoredVol, true);
  });
});
