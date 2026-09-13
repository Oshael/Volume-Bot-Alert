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
      { kind: 'rule', chain: 'robinhood', ruleKey: 'robinhood-hvnc-v2' },
      { kind: 'toggle-connection', version: 36 },
      { kind: 'toggle-profile', chain: 'solana', version: 35 },
      {
        kind: 'edit-rule-field', chain: 'solana',
        ruleKey: 'hvnc', field: 'minHvncVolumeUsd', version: 5,
      },
      {
        kind: 'toggle-rule', chain: 'robinhood',
        ruleKey: 'robinhood-hvnc-v2', version: 71,
      },
      {
        kind: 'confirm-reset-rule', chain: 'solana',
        ruleKey: 'hvnc', version: 5,
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
    for (const [chain, ruleKey] of [
      ['solana', 'monitored-vol'],
      ['solana', 'monitored-mcap'],
      ['robinhood', 'monitored-vol'],
      ['robinhood', 'monitored-fdv'],
    ]) {
      assert.throws(
        () => callbackData({ kind: 'rule', chain, ruleKey }),
        /Unsupported Telegram menu rule/
      );
    }
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
      rules: [{ rule_key: 'hvnc', enabled: false, version: 2 }],
    });
    const rule = renderMenu(
      { kind: 'rule', chain: 'solana', ruleKey: 'hvnc' },
      {
        rule: {
          enabled: true,
          version: 3,
          settings_json: {
            defaultsVersion: 1,
            minHvncVolumeUsd: 300_000,
            cooldownMinutes: 0,
          },
        },
      }
    );

    assert.match(main.text, /Status: Active ✅/);
    assert.match(main.text, /Networks: Solana/);
    assert.match(main.text, /Sparkline: Active ✅/);
    assert.equal(main.reply_markup.inline_keyboard[1][0].text, '⏸️ Pause deliveries');
    assert.equal(main.reply_markup.inline_keyboard[2][0].text, '👤 Account status');
    assert.equal(main.reply_markup.inline_keyboard[2][1].text, '❓ Help');
    assert.equal(main.reply_markup.inline_keyboard[3][0].text, '🔌 Disconnect');
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
    assert.match(chain.text, /Alerts \/ Solana/);
    assert.match(chain.text, /Network: Active ✅/);
    assert.match(chain.reply_markup.inline_keyboard[0][0].text, /❌ HVNC/);
    assert.match(chain.reply_markup.inline_keyboard[1][0].text, /Recent Surge 1H/);
    assert.doesNotMatch(JSON.stringify(chain), /Volume 5M|Market Cap 5M|FDV 5M/);
    assert.equal(chain.reply_markup.inline_keyboard.at(-2)[0].text, '❌ Deactivate network');
    assert.match(rule.text, /State: Active ✅/);
    assert.match(rule.text, /Minimum HVNC volume: \$300,000/);
    assert.equal(rule.reply_markup.inline_keyboard[0][0].text, '❌ Deactivate');
    const editButton = rule.reply_markup.inline_keyboard.flat().find(
      ({ text }) => text === '✏️ Change Minimum HVNC volume'
    );
    assert.deepEqual(parseCallbackData(editButton.callback_data), {
      kind: 'edit-rule-field',
      chain: 'solana',
      ruleKey: 'hvnc',
      field: 'minHvncVolumeUsd',
      version: 3,
    });
    assert.equal(isInputRoute(parseCallbackData(editButton.callback_data)), true);
    const mutation = parseCallbackData(
      rule.reply_markup.inline_keyboard[0][0].callback_data
    );
    assert.equal(isMutationRoute(mutation), true);
    assert.deepEqual(targetRoute(mutation), {
      kind: 'rule', chain: 'solana', ruleKey: 'hvnc',
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
    }).text, /Deliveries: Paused/);
    assert.match(renderMenu({ kind: 'main' }, {
      connection: { status: 'access_suspended' },
    }).text, /Status: Access suspended/);
    assert.match(renderMenu({ kind: 'help' }).text, /\/cancel ends an edit/);

    const portuguese = renderMenu({ kind: 'main' }, {
      connection: { status: 'active', language_code: 'pt-BR' },
      profiles: [{ chain: 'solana', enabled: true, sparkline_enabled: false }],
    });
    assert.match(portuguese.text, /Status: Ativo ✅/);
    assert.match(portuguese.text, /Sparkline: Desativada ❌/);
    assert.equal(portuguese.reply_markup.inline_keyboard[0][0].text, '🔔 Alertas');
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
          return [{ rule_key: 'hvnc' }];
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
      kind: 'rule', chain: 'robinhood', ruleKey: 'robinhood-hvnc-v2',
    });

    assert.equal(overview.profiles.length, 2);
    assert.equal(chain.rules.length, 1);
    assert.equal(rule.rule.rule_key, 'robinhood-hvnc-v2');
    assert.ok(calls.includes('rules:10'));
    assert.ok(calls.includes('rule:11:robinhood-hvnc-v2'));
  });
});
