const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  callbackData,
  isInputRoute,
  isMutationRoute,
  parseCallbackData,
  renderMenu,
  targetRoute,
} = require('../src/services/telegram-menu');
const {
  createTelegramSettingsReader,
} = require('../src/services/telegram-settings-reader');

describe('Telegram menu contracts', () => {
  it('round-trips only compact versioned routes from the supported catalog', () => {
    const routes = [
      { kind: 'main' },
      { kind: 'alerts' },
      { kind: 'status' },
      { kind: 'help' },
      { kind: 'confirm-disconnect', connectionId: '9007199254740993', version: 6 },
      { kind: 'disconnect', connectionId: '9007199254740993', version: 6 },
      { kind: 'chain', chain: 'solana' },
      { kind: 'rule', chain: 'robinhood', ruleKey: 'monitored-fdv' },
      { kind: 'toggle-connection', version: 36 },
      { kind: 'toggle-profile', chain: 'solana', version: 35 },
      {
        kind: 'edit-rule-field', chain: 'solana',
        ruleKey: 'monitored-vol', field: 'thresholdPct', version: 5,
      },
      {
        kind: 'toggle-rule', chain: 'robinhood',
        ruleKey: 'monitored-fdv', version: 71,
      },
      {
        kind: 'confirm-reset-rule', chain: 'solana',
        ruleKey: 'monitored-vol', version: 5,
      },
    ];
    for (const route of routes) {
      const encoded = callbackData(route);
      assert.ok(encoded.length <= 64);
      assert.deepEqual(parseCallbackData(encoded), route);
    }
    assert.equal(parseCallbackData('ts1:r:s:claim'), null);
    assert.equal(parseCallbackData('ts2:m'), null);
    assert.equal(parseCallbackData(`ts1:m${'x'.repeat(60)}`), null);
    assert.equal(parseCallbackData('ts1:t:r:f:0'), null);
    assert.throws(
      () => callbackData({ kind: 'rule', chain: 'solana', ruleKey: 'monitored-fdv' }),
      /Unsupported Telegram menu rule/
    );
  });

  it('renders versioned controls without exposing claims', () => {
    const main = renderMenu({ kind: 'main' }, {
      connection: { id: '9007199254740993', status: 'active', version: 6 },
      profiles: [
        { chain: 'solana', enabled: true, sparkline_enabled: true },
        { chain: 'robinhood', enabled: false, sparkline_enabled: true },
      ],
    });
    const chain = renderMenu({ kind: 'chain', chain: 'solana' }, {
      profile: {
        chain: 'solana', enabled: true, sparkline_enabled: true, version: 4,
      },
      rules: [{ rule_key: 'monitored-vol', enabled: false, version: 2 }],
    });
    const rule = renderMenu(
      { kind: 'rule', chain: 'solana', ruleKey: 'monitored-vol' },
      {
        rule: {
          enabled: true,
          version: 3,
          settings_json: {
            defaultsVersion: 1,
            thresholdPct: 50,
            cooldownMinutes: 1,
            minVolumeUsd: 10_000,
          },
        },
      }
    );

    assert.match(main.text, /Redes: Solana/);
    assert.equal(main.reply_markup.inline_keyboard[1][0].text, 'Pausar entregas');
    assert.equal(main.reply_markup.inline_keyboard[2][0].text, 'Status da conta');
    assert.equal(main.reply_markup.inline_keyboard[2][1].text, 'Ajuda');
    assert.equal(main.reply_markup.inline_keyboard[3][0].text, 'Desconectar');
    const disconnectPrompt = parseCallbackData(
      main.reply_markup.inline_keyboard[3][0].callback_data
    );
    const disconnectConfirmation = renderMenu(disconnectPrompt);
    assert.deepEqual(parseCallbackData(
      disconnectConfirmation.reply_markup.inline_keyboard[0][0].callback_data
    ), {
      kind: 'disconnect',
      connectionId: '9007199254740993',
      version: 6,
    });
    const connectionMutation = parseCallbackData(
      main.reply_markup.inline_keyboard[1][0].callback_data
    );
    assert.equal(isMutationRoute(connectionMutation), true);
    assert.deepEqual(targetRoute(connectionMutation), { kind: 'main' });
    assert.match(chain.text, /Alertas \/ Solana/);
    assert.match(chain.reply_markup.inline_keyboard[0][0].text, /⏸ Volume 5M/);
    assert.match(chain.reply_markup.inline_keyboard[1][0].text, /Market Cap 5M/);
    assert.equal(chain.reply_markup.inline_keyboard.at(-2)[0].text, 'Desativar rede');
    assert.match(rule.text, /Threshold: 50%/);
    assert.match(rule.text, /Volume mínimo: \$10,000/);
    assert.equal(rule.reply_markup.inline_keyboard[0][0].text, 'Desativar');
    const editButton = rule.reply_markup.inline_keyboard.flat().find(
      ({ text }) => text === 'Alterar Threshold'
    );
    assert.deepEqual(parseCallbackData(editButton.callback_data), {
      kind: 'edit-rule-field',
      chain: 'solana',
      ruleKey: 'monitored-vol',
      field: 'thresholdPct',
      version: 3,
    });
    assert.equal(isInputRoute(parseCallbackData(editButton.callback_data)), true);
    const mutation = parseCallbackData(
      rule.reply_markup.inline_keyboard[0][0].callback_data
    );
    assert.equal(isMutationRoute(mutation), true);
    assert.deepEqual(targetRoute(mutation), {
      kind: 'rule', chain: 'solana', ruleKey: 'monitored-vol',
    });
    const confirmationRoute = parseCallbackData(
      rule.reply_markup.inline_keyboard[1][0].callback_data
    );
    assert.equal(confirmationRoute.kind, 'confirm-reset-rule');
    const confirmation = renderMenu(confirmationRoute);
    assert.equal(
      parseCallbackData(
        confirmation.reply_markup.inline_keyboard[0][0].callback_data
      ).kind,
      'reset-rule'
    );
    assert.doesNotMatch(JSON.stringify([main, chain, rule]), /claim/i);
    assert.match(renderMenu({ kind: 'status' }, {
      access: { hasProductAccess: true },
      connection: { status: 'paused', last_error_code: 'blocked' },
    }).text, /Entregas: Pausadas/);
    assert.match(renderMenu({ kind: 'main' }, {
      connection: { status: 'access_suspended' },
    }).text, /Status: Acesso suspenso/);
    assert.match(renderMenu({ kind: 'help' }).text, /\/cancel encerra uma edição/);
  });

  it('reads profiles and rules behind one navigation interface', async () => {
    const calls = [];
    const reader = createTelegramSettingsReader({
      profileModel: {
        async findByUserAndChain(userId, chain) {
          calls.push(`profile:${userId}:${chain}`);
          return { id: chain === 'solana' ? 10 : 11, chain };
        },
      },
      ruleSettingModel: {
        async listByProfileId(profileId) {
          calls.push(`rules:${profileId}`);
          return [{ rule_key: 'monitored-vol' }];
        },
        async findByProfileAndRule(profileId, ruleKey) {
          calls.push(`rule:${profileId}:${ruleKey}`);
          return { profile_id: profileId, rule_key: ruleKey };
        },
      },
    });

    const overview = await reader.read(7, { kind: 'main' });
    const callsAfterOverview = calls.length;
    assert.deepEqual(await reader.read(7, { kind: 'help' }), {});
    assert.equal(calls.length, callsAfterOverview);
    const chain = await reader.read(7, { kind: 'chain', chain: 'solana' });
    const rule = await reader.read(7, {
      kind: 'rule', chain: 'robinhood', ruleKey: 'monitored-fdv',
    });

    assert.equal(overview.profiles.length, 2);
    assert.equal(chain.rules.length, 1);
    assert.equal(rule.rule.rule_key, 'monitored-fdv');
    assert.ok(calls.includes('rules:10'));
    assert.ok(calls.includes('rule:11:monitored-fdv'));
  });
});
