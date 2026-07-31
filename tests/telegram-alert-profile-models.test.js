const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const profileModel = require('../src/models/telegram-alert-profile');
const ruleSettingModel = require('../src/models/telegram-alert-rule-setting');
const ruleContracts = require('../src/services/telegram-alert-rule-contracts');

function database(rows = []) {
  const calls = [];
  return {
    calls,
    db: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows };
      },
    },
  };
}

describe('Telegram alert profile model', () => {
  it('binds both chain profiles without replacing independent preferences', async () => {
    const { calls, db } = database([{ id: 10 }, { id: 11 }]);
    const result = await profileModel.bindConnection({
      userId: 7,
      connectionId: 20,
    }, db);

    assert.equal(result.length, 2);
    assert.deepEqual(calls[0].params, [7, 20, ['solana', 'robinhood']]);
    assert.deepEqual(calls[1].params, [7]);
    assert.match(calls[0].sql, /ON CONFLICT \(user_id, chain\) DO UPDATE/);
    assert.match(calls[0].sql, /connection_id = EXCLUDED\.connection_id/);
    assert.match(calls[0].sql, /version = telegram_alert_profiles\.version \+ 1/);
    assert.doesNotMatch(calls[0].sql, /SET[\s\S]*enabled =/);
    assert.doesNotMatch(calls[0].sql, /SET[\s\S]*sparkline_enabled =/);
  });

  it('scopes profile reads to one user and chain', async () => {
    const row = { id: 10, user_id: 7, chain: 'solana' };
    const { calls, db } = database([row]);

    assert.equal(await profileModel.findByUserAndChain(7, 'solana', db), row);
    assert.deepEqual(calls[0].params, [7, 'solana']);
  });

  it('uses the expected version when updating profile preferences', async () => {
    const row = { id: 10, version: 4 };
    const { calls, db } = database([row]);
    const result = await profileModel.updatePreferences({
      userId: 7,
      chain: 'robinhood',
      enabled: false,
      expectedVersion: 3,
    }, db);

    assert.equal(result, row);
    assert.deepEqual(calls[0].params, [7, 'robinhood', false, null, 3]);
    assert.match(calls[0].sql, /WHERE user_id = \$1[\s\S]*chain = \$2[\s\S]*version = \$5/);
    assert.match(calls[0].sql, /version = version \+ 1/);
  });

  it('returns null after an optimistic-lock miss', async () => {
    const { db } = database();
    const result = await profileModel.updatePreferences({
      userId: 7,
      chain: 'solana',
      sparklineEnabled: false,
      expectedVersion: 8,
    }, db);
    assert.equal(result, null);
  });
});

describe('Telegram alert rule setting model', () => {
  it('persists an object payload for a profile rule', async () => {
    const row = { id: 31, profile_id: 10 };
    const { calls, db } = database([row]);
    const result = await ruleSettingModel.create({
      profileId: 10,
      chain: 'solana',
      ruleKey: 'monitored-vol',
      enabled: true,
      settings: {
        defaultsVersion: 1, thresholdPct: 50, cooldownMinutes: 1, minVolumeUsd: 5000,
      },
    }, db);

    assert.equal(result, row);
    assert.deepEqual(calls[0].params, [
      10, 'solana', 'monitored-vol', true,
      '{"defaultsVersion":1,"thresholdPct":50,"cooldownMinutes":1,"minVolumeUsd":5000}',
    ]);
    assert.match(calls[0].sql, /\$5::jsonb/);
  });

  it('updates a rule only at the expected version', async () => {
    const row = { id: 31, version: 3 };
    const { calls, db } = database([row]);
    const result = await ruleSettingModel.update({
      profileId: 10,
      chain: 'solana',
      ruleKey: 'monitored-vol',
      enabled: false,
      settings: {
        defaultsVersion: 1, thresholdPct: 80, cooldownMinutes: 1, minVolumeUsd: 8000,
      },
      expectedVersion: 2,
    }, db);

    assert.equal(result, row);
    assert.deepEqual(calls[0].params, [
      10, 'solana', 'monitored-vol', false,
      '{"defaultsVersion":1,"thresholdPct":80,"cooldownMinutes":1,"minVolumeUsd":8000}',
      2,
    ]);
    assert.match(calls[0].sql, /version = version \+ 1/);
    assert.match(
      calls[0].sql,
      /profile_id = \$1[\s\S]*chain = \$2[\s\S]*rule_key = \$3[\s\S]*version = \$6/
    );
  });

  it('rejects non-object settings before querying the database', async () => {
    const { calls, db } = database();
    await assert.rejects(
      () => ruleSettingModel.create({
        profileId: 10,
        chain: 'solana',
        ruleKey: 'monitored-vol',
        enabled: true,
        settings: [],
      }, db),
      /must be an object/
    );
    assert.equal(calls.length, 0);
  });
});

describe('Telegram alert rule contracts', () => {
  it('preserves current matcher defaults and excludes claims', () => {
    const solana = ruleContracts.buildDefaultRules('solana');
    const robinhood = ruleContracts.buildDefaultRules('robinhood');
    const byKey = (rules, key) => rules.find((rule) => rule.ruleKey === key);

    assert.deepEqual(
      solana.map((rule) => rule.ruleKey).sort(),
      [
        'hvnc', 'meteora-surge', 'monitored-mcap', 'monitored-vol',
        'old-week-surge-1h', 'old-week-surge-6h',
        'recent-surge-1h', 'recent-surge-6h',
      ]
    );
    assert.equal(byKey(robinhood, 'monitored-fdv').enabled, false);
    assert.equal(byKey(solana, 'monitored-vol').settings.cooldownMinutes, 1);
    assert.equal(byKey(solana, 'monitored-vol').settings.defaultsVersion, 1);
    assert.equal(byKey(solana, 'hvnc').settings.cooldownMinutes, 0);
    assert.equal(byKey(solana, 'recent-surge-6h').settings.cooldownMinutes, 360);
    assert.equal(byKey(solana, 'meteora-surge').settings.cooldownMinutes, 30);
    assert.equal(JSON.stringify([...solana, ...robinhood]).includes('claim'), false);
  });

  it('rejects unknown, missing, non-integer and inconsistent settings', () => {
    const valid = {
      defaultsVersion: 1,
      thresholdPct: 50,
      cooldownMinutes: 1,
      minVolumeUsd: 10_000,
      minMarketCapUsd: 30_000,
      maxMarketCapUsd: 0,
    };
    const invalid = [
      [{ ...valid, surprise: 1 }, /unknown=surprise/],
      [{ ...valid, thresholdPct: undefined }, /between 0 and 10000/],
      [{ ...valid, cooldownMinutes: 1.5 }, /must be an integer/],
      [{ ...valid, maxMarketCapUsd: 20_000 }, /must be zero or greater/],
    ];
    for (const [settings, expected] of invalid) {
      assert.throws(
        () => ruleContracts.validateRuleSettings(
          'solana', 'monitored-mcap', settings
        ),
        expected
      );
    }
    assert.throws(
      () => ruleContracts.validateRuleSettings('solana', 'claim', {}),
      /Unsupported Telegram alert rule/
    );
  });

  it('creates missing defaults idempotently for each profile', async () => {
    const { calls, db } = database([{ id: 31 }]);
    const created = await ruleSettingModel.ensureDefaults([
      { id: 10, chain: 'solana' },
      { id: 11, chain: 'robinhood' },
    ], db);

    assert.equal(created.length, 2);
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /ON CONFLICT \(profile_id, rule_key\) DO NOTHING/);
    assert.deepEqual(calls.map((call) => call.params.slice(0, 2)), [
      [10, 'solana'],
      [11, 'robinhood'],
    ]);
  });
});
