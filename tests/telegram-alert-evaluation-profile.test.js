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
  it('preserves independent Solana rule settings, cooldowns and bigint identities', () => {
    const input = fixture('solana');
    const volume = input.rules.find((item) => item.rule_key === 'monitored-vol');
    const mcap = input.rules.find((item) => item.rule_key === 'monitored-mcap');
    volume.settings_json = {
      ...volume.settings_json,
      thresholdPct: 75,
      cooldownMinutes: 2,
      minVolumeUsd: 5_000,
    };
    mcap.settings_json = {
      ...mcap.settings_json,
      thresholdPct: 90,
      cooldownMinutes: 9,
      minVolumeUsd: 25_000,
    };

    const result = adaptTelegramAlertEvaluationProfile(input);

    assert.equal(result.destination, 'telegram');
    assert.equal(result.profileId, '9007199254740993');
    assert.equal(result.connectionId, '9007199254740995');
    assert.equal(result.userId, 7);
    assert.equal(result.updatedAt, '2026-07-29T12:00:00.000Z');
    assert.equal(rule(result, 'monitored-vol').updatedAt, '2026-07-29T12:00:00.000Z');
    assert.equal(result.ruleEnabled.monitoredVol, true);
    assert.equal(rule(result, 'monitored-vol').settings.minVolumeUsd, 5_000);
    assert.equal(rule(result, 'monitored-vol').cooldownMs, 120_000);
    assert.equal(rule(result, 'monitored-mcap').settings.minVolumeUsd, 25_000);
    assert.equal(rule(result, 'monitored-mcap').cooldownMs, 540_000);
    assert.notEqual(
      rule(result, 'monitored-vol').settings,
      rule(result, 'monitored-mcap').settings
    );
  });

  it('keeps Robinhood rule enablement and versions scoped to each rule', () => {
    const input = fixture('robinhood', {
      profile: { enabled: false, sparkline_enabled: false, version: 8 },
    });
    const fdv = input.rules.find((item) => item.rule_key === 'monitored-fdv');
    fdv.enabled = true;
    fdv.version = 12;

    const result = adaptTelegramAlertEvaluationProfile(input);

    assert.equal(result.chain, 'robinhood');
    assert.equal(result.enabled, false);
    assert.equal(result.sparklineEnabled, false);
    assert.equal(result.version, 8);
    assert.equal(rule(result, 'monitored-fdv').enabled, true);
    assert.equal(rule(result, 'monitored-fdv').version, 12);
    assert.equal(result.rules.some((item) => item.ruleKey.includes('claim')), false);
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
