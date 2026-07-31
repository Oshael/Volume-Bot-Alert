const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  TelegramSettingsConflictError,
  createTelegramSettingsService,
} = require('../src/services/telegram-settings-service');

function fixture(options = {}) {
  const calls = [];
  const profile = {
    id: 10,
    user_id: 7,
    chain: 'solana',
    enabled: true,
    sparkline_enabled: true,
    version: 3,
  };
  const rule = {
    profile_id: 10,
    chain: 'solana',
    rule_key: 'monitored-vol',
    enabled: true,
    settings_json: {
      defaultsVersion: 1,
      thresholdPct: 80,
      cooldownMinutes: 2,
      minVolumeUsd: 20_000,
    },
    version: 5,
  };
  const service = createTelegramSettingsService({
    connectionModel: {
      async findActiveByUserId(userId) {
        calls.push(['connection', userId]);
        return options.connection === null
          ? null
          : { user_id: userId, status: options.status || 'active', version: 7 };
      },
      async setDeliveryStatus(input) {
        calls.push(['update-connection', input]);
        return options.conflict ? null : { ...input, version: input.expectedVersion + 1 };
      },
    },
    profileModel: {
      async findByUserAndChain(userId, chain) {
        calls.push(['profile', userId, chain]);
        return options.profile === null ? null : profile;
      },
      async updatePreferences(input) {
        calls.push(['update-profile', input]);
        return options.conflict ? null : { ...profile, version: input.expectedVersion + 1 };
      },
    },
    ruleSettingModel: {
      async findByProfileAndRule(profileId, ruleKey) {
        calls.push(['rule', profileId, ruleKey]);
        return options.rule === null ? null : rule;
      },
      async update(input) {
        calls.push(['update-rule', input]);
        return options.conflict ? null : { ...rule, version: input.expectedVersion + 1 };
      },
    },
  });
  return { calls, service };
}

describe('Telegram settings service', () => {
  it('pauses and resumes delivery without reviving terminal connection states', async () => {
    for (const [status, target] of [['active', 'paused'], ['paused', 'active']]) {
      const { calls, service } = fixture({ status });
      await service.apply(7, { kind: 'toggle-connection', version: 7 });
      assert.deepEqual(calls.at(-1), ['update-connection', {
        userId: 7,
        status: target,
        expectedVersion: 7,
      }]);
    }

    for (const options of [{ connection: null }, { status: 'access_suspended' }]) {
      const { service } = fixture(options);
      await assert.rejects(
        () => service.apply(7, { kind: 'toggle-connection', version: 7 }),
        TelegramSettingsConflictError
      );
    }
  });

  it('sets an explicit delivery status for idempotent command shortcuts', async () => {
    const { calls, service } = fixture({ status: 'active' });
    await service.apply(7, {
      kind: 'set-connection-status',
      status: 'paused',
      version: 7,
    });

    assert.deepEqual(calls.at(-1), ['update-connection', {
      userId: 7,
      status: 'paused',
      expectedVersion: 7,
    }]);
  });

  it('toggles profile preferences within the authorized user and expected version', async () => {
    const { calls, service } = fixture();
    await service.apply(7, { kind: 'toggle-profile', chain: 'solana', version: 3 });
    await service.apply(7, { kind: 'toggle-sparkline', chain: 'solana', version: 4 });

    assert.deepEqual(calls[1], ['update-profile', {
      userId: 7,
      chain: 'solana',
      expectedVersion: 3,
      enabled: false,
    }]);
    assert.deepEqual(calls[3], ['update-profile', {
      userId: 7,
      chain: 'solana',
      expectedVersion: 4,
      sparklineEnabled: false,
    }]);
  });

  it('toggles a rule without changing its independent settings', async () => {
    const { calls, service } = fixture();
    await service.apply(7, {
      kind: 'toggle-rule',
      chain: 'solana',
      ruleKey: 'monitored-vol',
      version: 5,
    });

    const input = calls.at(-1)[1];
    assert.equal(input.enabled, false);
    assert.equal(input.settings.thresholdPct, 80);
    assert.equal(input.expectedVersion, 5);
  });

  it('changes one rule field without changing state or sibling settings', async () => {
    const { calls, service } = fixture();
    await service.apply(7, {
      kind: 'set-rule-field',
      chain: 'solana',
      ruleKey: 'monitored-vol',
      field: 'thresholdPct',
      value: 75,
      version: 5,
    });

    const input = calls.at(-1)[1];
    assert.equal(input.enabled, true);
    assert.equal(input.settings.thresholdPct, 75);
    assert.equal(input.settings.cooldownMinutes, 2);
    assert.equal(input.expectedVersion, 5);
  });

  it('restores the versioned defaults and default enabled state', async () => {
    const { calls, service } = fixture();
    await service.apply(7, {
      kind: 'reset-rule',
      chain: 'solana',
      ruleKey: 'monitored-vol',
      version: 5,
    });

    const input = calls.at(-1)[1];
    assert.equal(input.enabled, true);
    assert.deepEqual(input.settings, {
      defaultsVersion: 1,
      thresholdPct: 50,
      cooldownMinutes: 1,
      minVolumeUsd: 10_000,
    });
  });

  it('surfaces missing rows and optimistic misses as stale-menu conflicts', async () => {
    for (const options of [{ profile: null }, { conflict: true }]) {
      const { service } = fixture(options);
      await assert.rejects(
        () => service.apply(7, {
          kind: 'toggle-profile', chain: 'solana', version: 2,
        }),
        TelegramSettingsConflictError
      );
    }
  });
});
