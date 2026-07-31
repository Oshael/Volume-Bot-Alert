const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  EDIT_RULE_SETTING,
  INPUT_SESSION_TTL_MS,
  TelegramInputValueError,
  createTelegramInputSessionService,
} = require('../src/services/telegram-input-session-service');
const {
  TelegramSettingsConflictError,
} = require('../src/services/telegram-settings-service');

function fixture(options = {}) {
  const calls = [];
  const rule = options.rule === null ? null : {
    version: options.ruleVersion || 5,
    enabled: true,
    settings_json: {
      defaultsVersion: 1,
      thresholdPct: 50,
      cooldownMinutes: 1,
      minVolumeUsd: 10_000,
    },
  };
  const service = createTelegramInputSessionService({
    now: () => new Date('2026-07-29T15:00:00.000Z'),
    inputSessionModel: {
      async replace(input) {
        calls.push(['replace', input]);
        return input;
      },
      async findActive(input) {
        calls.push(['find', input]);
        return options.session ?? null;
      },
      async clear(input) {
        calls.push(['clear', input]);
        return 1;
      },
    },
    settingsReader: {
      async read(userId, route) {
        calls.push(['read', userId, route]);
        return { rule };
      },
    },
    settingsService: {
      async apply(userId, route) {
        calls.push(['apply', userId, route]);
        if (options.conflict) throw new TelegramSettingsConflictError();
        return { version: route.version + 1 };
      },
    },
  });
  return { calls, service };
}

describe('Telegram input session service', () => {
  it('starts a ten-minute edit session with a closed, versioned payload', async () => {
    const { calls, service } = fixture();
    await service.start({
      userId: 7,
      telegramUserId: 123n,
      chain: 'solana',
      ruleKey: 'monitored-vol',
      field: 'thresholdPct',
      expectedVersion: 5,
    });

    assert.deepEqual(calls[1], ['replace', {
      telegramUserId: '123',
      userId: 7,
      action: EDIT_RULE_SETTING,
      payload: {
        chain: 'solana',
        ruleKey: 'monitored-vol',
        field: 'thresholdPct',
        expectedVersion: 5,
      },
      expiresAt: new Date('2026-07-29T15:10:00.000Z'),
    }]);
    assert.equal(INPUT_SESSION_TTL_MS, 10 * 60 * 1000);
  });

  it('rejects unsupported fields, rules, identities, and stale version shapes', async () => {
    const invalid = [
      { field: 'defaultsVersion' },
      { field: 'unknown' },
      { ruleKey: 'monitored-fdv' },
      { telegramUserId: 'invalid' },
      { expectedVersion: 0 },
    ];
    for (const override of invalid) {
      const { calls, service } = fixture();
      await assert.rejects(() => service.start({
        userId: 7,
        telegramUserId: '123',
        chain: 'solana',
        ruleKey: 'monitored-vol',
        field: 'thresholdPct',
        expectedVersion: 5,
        ...override,
      }), TypeError);
      assert.deepEqual(calls, []);
    }
  });

  it('scopes reads and cancellation to both account and Telegram identity', async () => {
    const payload = {
      chain: 'robinhood',
      ruleKey: 'monitored-fdv',
      field: 'cooldownMinutes',
      expectedVersion: 8,
    };
    const { calls, service } = fixture({
      session: { action: EDIT_RULE_SETTING, payload_json: payload },
    });

    const found = await service.find({ userId: 9, telegramUserId: '456' });
    await service.cancel({ userId: 9, telegramUserId: '456' });

    assert.deepEqual(found.payload, payload);
    assert.deepEqual(calls[0], ['find', { userId: 9, telegramUserId: '456' }]);
    assert.deepEqual(calls[1], ['clear', { userId: 9, telegramUserId: '456' }]);
  });

  it('validates and applies a decimal reply while preserving optimistic versioning', async () => {
    const payload = {
      chain: 'solana',
      ruleKey: 'monitored-vol',
      field: 'thresholdPct',
      expectedVersion: 5,
    };
    const { calls, service } = fixture({
      session: { action: EDIT_RULE_SETTING, payload_json: payload },
    });

    const result = await service.submit({
      userId: 7, telegramUserId: '123', text: '75,5',
    });

    const apply = calls.find(([name]) => name === 'apply');
    assert.equal(apply[2].value, 75.5);
    assert.equal(apply[2].version, 5);
    assert.deepEqual(result.route, {
      kind: 'rule', chain: 'solana', ruleKey: 'monitored-vol',
    });
    assert.equal(calls.at(-1)[0], 'clear');
  });

  it('keeps the session for invalid input and clears it after a version conflict', async () => {
    const payload = {
      chain: 'solana',
      ruleKey: 'monitored-vol',
      field: 'cooldownMinutes',
      expectedVersion: 5,
    };
    const invalid = fixture({
      session: { action: EDIT_RULE_SETTING, payload_json: payload },
    });
    await assert.rejects(
      () => invalid.service.submit({
        userId: 7, telegramUserId: '123', text: '1.5',
      }),
      TelegramInputValueError
    );
    assert.equal(invalid.calls.some(([name]) => name === 'clear'), false);

    const stale = fixture({
      session: { action: EDIT_RULE_SETTING, payload_json: payload },
      ruleVersion: 6,
    });
    await assert.rejects(
      () => stale.service.submit({
        userId: 7, telegramUserId: '123', text: '2',
      }),
      TelegramSettingsConflictError
    );
    assert.equal(stale.calls.at(-1)[0], 'clear');
  });
});
