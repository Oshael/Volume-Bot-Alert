const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  adaptTelegramAlertEvaluationProfile,
} = require('../src/services/telegram-alert-evaluation-profile');
const {
  buildDefaultRules,
} = require('../src/services/telegram-alert-rule-contracts');

function fixture(chain, overrides = {}) {
  const profile = {
    id: '9007199254740993',
    connection_id: '9007199254740995',
    user_id: 7,
    chain,
    enabled: true,
    sparkline_enabled: true,
    version: 3,
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides.profile,
  };
  const rules = buildDefaultRules(chain).map((rule, index) => ({
    profile_id: profile.id,
    chain,
    rule_key: rule.ruleKey,
    enabled: rule.enabled,
    settings_json: rule.settings,
    version: index + 1,
    updated_at: `2026-07-29T12:0${index}:00.000Z`,
  }));
  return { profile, rules };
}

function rule(profile, ruleKey) {
  return profile.rules.find((item) => item.ruleKey === ruleKey);
}

describe('Telegram alert evaluation profile adapter', () => {
  it('preserves active Solana rule settings, cooldowns and bigint identities', () => {
    const input = fixture('solana');
    const hvnc = input.rules.find((item) => item.rule_key === 'hvnc');
    const recent = input.rules.find((item) => item.rule_key === 'recent-surge-1h');
    hvnc.settings_json = {
      ...hvnc.settings_json,
      cooldownMinutes: 2,
      minHvncVolumeUsd: 500_000,
    };
    recent.settings_json = {
      ...recent.settings_json,
      thresholdPct: 90,
      cooldownMinutes: 9,
    };

    const result = adaptTelegramAlertEvaluationProfile(input);

    assert.equal(result.destination, 'telegram');
    assert.equal(result.profileId, '9007199254740993');
    assert.equal(result.connectionId, '9007199254740995');
    assert.equal(result.userId, 7);
    assert.equal(result.updatedAt, '2026-07-29T12:00:00.000Z');
    assert.equal(rule(result, 'hvnc').updatedAt, '2026-07-29T12:00:00.000Z');
    assert.equal(result.ruleEnabled.hvnc, true);
    assert.equal(rule(result, 'hvnc').settings.minHvncVolumeUsd, 500_000);
    assert.equal(rule(result, 'hvnc').cooldownMs, 120_000);
    assert.equal(rule(result, 'recent-surge-1h').settings.thresholdPct, 90);
    assert.equal(rule(result, 'recent-surge-1h').cooldownMs, 540_000);
    assert.notEqual(
      rule(result, 'hvnc').settings,
      rule(result, 'recent-surge-1h').settings
    );
  });

  it('ignores compatible retired rows while keeping active Robinhood rules scoped', () => {
    const input = fixture('robinhood', {
      profile: { enabled: false, sparkline_enabled: false, version: 8 },
    });
    const hvnc = input.rules.find((item) => item.rule_key === 'robinhood-hvnc-v2');
    hvnc.version = 12;
    input.rules.push({
      profile_id: input.profile.id,
      chain: 'robinhood',
      rule_key: 'monitored-fdv',
      enabled: true,
      settings_json: {
        defaultsVersion: 1, thresholdPct: 50, cooldownMinutes: 1,
        minVolumeUsd: 10_000, minFdvUsd: 30_000, maxFdvUsd: 0,
      },
      version: 99,
      updated_at: '2026-07-29T12:09:00.000Z',
    });

    const result = adaptTelegramAlertEvaluationProfile(input);

    assert.equal(result.chain, 'robinhood');
    assert.equal(result.enabled, false);
    assert.equal(result.sparklineEnabled, false);
    assert.equal(result.version, 8);
    assert.equal(rule(result, 'robinhood-hvnc-v2').version, 12);
    assert.equal(rule(result, 'monitored-fdv'), undefined);
    assert.equal(result.ruleEnabled.monitoredFdv, undefined);
    assert.equal(result.rules.some((item) => item.ruleKey.includes('claim')), false);
  });

  it('adapts a consistent pending or completed reactivation boundary', () => {
    const pendingInput = fixture('solana');
    pendingInput.reactivation = {
      status: 'access_suspended',
      requested_at: '2026-07-29T13:00:00.000Z',
      reactivated_at: null,
    };
    const activeInput = fixture('solana');
    activeInput.reactivation = {
      status: 'active',
      requested_at: null,
      reactivated_at: '2026-07-29T13:00:00.000Z',
    };

    assert.deepEqual(adaptTelegramAlertEvaluationProfile(pendingInput).reactivation, {
      pending: true,
      requestedAt: '2026-07-29T13:00:00.000Z',
      reactivatedAt: null,
    });
    assert.equal(
      adaptTelegramAlertEvaluationProfile(activeInput).reactivation.reactivatedAt,
      '2026-07-29T13:00:00.000Z',
    );
    activeInput.reactivation.requested_at = '2026-07-29T13:00:00.000Z';
    assert.throws(
      () => adaptTelegramAlertEvaluationProfile(activeInput),
      /reactivation context is inconsistent/,
    );
  });

  it('fails closed for incomplete, duplicate or cross-profile rule sets', () => {
    const cases = [
      {
        mutate(input) { input.rules.pop(); },
        expected: /Missing Telegram alert rule/,
      },
      {
        mutate(input) { input.rules.push({ ...input.rules[0] }); },
        expected: /Duplicate Telegram alert rule/,
      },
      {
        mutate(input) { input.rules[0].profile_id = '999'; },
        expected: /profile mismatch/,
      },
      {
        mutate(input) { input.rules[0].settings_json.cooldownMinutes = 1.5; },
        expected: /must be an integer/,
      },
    ];

    for (const testCase of cases) {
      const input = fixture('solana');
      testCase.mutate(input);
      assert.throws(
        () => adaptTelegramAlertEvaluationProfile(input),
        testCase.expected
      );
    }
  });
});
