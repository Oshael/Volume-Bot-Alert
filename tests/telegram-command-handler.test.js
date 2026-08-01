const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramCommandHandler,
  parseCancelCommand,
  parseGlobalCommand,
  parseMenuCommand,
  parseStartCommand,
} = require('../src/services/telegram-command-handler');
const {
  TelegramLinkError,
} = require('../src/services/telegram-link-service');
const {
  TelegramSettingsConflictError,
} = require('../src/services/telegram-settings-service');

function message(text, options = {}) {
  return {
    message: {
      text,
      chat: {
        id: options.chatId ?? 123,
        type: options.chatType || 'private',
      },
      from: {
        id: options.userId ?? 123,
        username: 'alice',
        first_name: 'Alice',
        ...(options.languageCode ? { language_code: options.languageCode } : {}),
      },
    },
  };
}

function fixture(linkService, options = {}) {
  const sent = [];
  const answered = [];
  const edited = [];
  const inputCalls = [];
  const handler = createTelegramCommandHandler({
    linkService,
    settingsReader: {
      async read() {
        return options.settingsContext || {
          profiles: [{ chain: 'solana', enabled: true, sparkline_enabled: true }],
          rules: [{ rule_key: 'monitored-vol', enabled: true }],
          rule: {
            rule_key: 'monitored-vol',
            enabled: true,
            settings_json: {
              defaultsVersion: 1,
              thresholdPct: 50,
              cooldownMinutes: 1,
              minVolumeUsd: 10_000,
            },
          },
        };
      },
    },
    inputSessionService: {
      async start(input) {
        inputCalls.push(['start', input]);
        return options.inputStart || { text: 'Send the new value.' };
      },
      async submit(input) {
        inputCalls.push(['submit', input]);
        return options.inputSubmitResult ?? null;
      },
      async cancel(input) {
        inputCalls.push(['cancel', input]);
        return options.inputCanceled ?? 1;
      },
    },
    settingsService: {
      async apply(userId, route) {
        if (options.mutationError) throw options.mutationError;
        options.mutations?.push([userId, route]);
        return options.mutationResult;
      },
    },
    botClient: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
  });
  return { answered, edited, handler, inputCalls, sent };
}

describe('Telegram basic command handler', () => {
  it('parses only bounded /start payloads', () => {
    assert.deepEqual(parseStartCommand('/start'), { token: null });
    assert.deepEqual(parseStartCommand(`/start@trend_scope_bot ${'a'.repeat(43)}`), {
      token: 'a'.repeat(43),
    });
    assert.equal(parseStartCommand('/settings'), null);
    assert.equal(parseStartCommand('/start short'), null);
    assert.deepEqual(parseMenuCommand('/settings'), { token: null });
    assert.deepEqual(parseMenuCommand('/settings@trend_scope_bot'), { token: null });
    assert.equal(parseCancelCommand('/cancel@trend_scope_bot'), true);
    assert.deepEqual(parseGlobalCommand('/status'), {
      kind: 'view', route: { kind: 'status' },
    });
    assert.deepEqual(parseGlobalCommand('/pause'), {
      kind: 'delivery-status', status: 'paused',
    });
    assert.deepEqual(parseGlobalCommand('/disconnect'), {
      kind: 'disconnect-prompt',
    });
  });

  it('ignores non-private and mismatched conversations before linking', async () => {
    const linkService = {
      async completeLink() {
        assert.fail('group messages must not reach link completion');
      },
      async findAuthorizedConnection() {
        assert.fail('group messages must not resolve connections');
      },
    };
    const { handler, sent } = fixture(linkService);

    const group = await handler.handleUpdate(message(`/start ${'a'.repeat(43)}`, {
      chatType: 'group',
    }));
    const mismatch = await handler.handleUpdate(message('/start', { chatId: 456 }));

    assert.deepEqual(group, { ignored: true });
    assert.deepEqual(mismatch, { ignored: true });
    assert.deepEqual(sent, []);
  });

  it('completes a valid link and sends the basic menu after access was approved', async () => {
    const calls = [];
    const { handler, sent } = fixture({
      async completeLink(input) {
        calls.push(input);
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
      async findAuthorizedConnection() {
        assert.fail('a successful token must not use fallback lookup');
      },
    });

    const result = await handler.handleUpdate(message(`/start ${'b'.repeat(43)}`));

    assert.deepEqual(result, { handled: true });
    assert.equal(calls[0].telegramUserId, '123');
    assert.equal(calls[0].chatId, '123');
    assert.equal(calls[0].username, 'alice');
    assert.equal(calls[0].languageCode, undefined);
    assert.equal(sent[0].chat_id, '123');
    assert.match(sent[0].text, /Status: Active/);
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].text, '🔔 Alerts');
  });

  it('forwards a canonical Telegram language code during linking', async () => {
    const calls = [];
    const { handler, sent } = fixture({
      async completeLink(input) {
        calls.push(input);
        return {
          access: { hasProductAccess: true },
          connection: {
            chat_id: '123', status: 'active', user_id: 7, language_code: 'pt-BR',
          },
        };
      },
    });

    await handler.handleUpdate(message(`/start ${'l'.repeat(43)}`, {
      languageCode: 'pt_br',
    }));

    assert.equal(calls[0].languageCode, 'pt-BR');
    assert.match(sent[0].text, /Status: Ativo ✅/);
  });

  it('recovers the menu from an existing authorized link after token replay', async () => {
    let fallbackCalls = 0;
    const { handler, sent } = fixture({
      async completeLink() {
        throw new TelegramLinkError('expired', 409, 'invalid_link');
      },
      async findAuthorizedConnection(identity) {
        fallbackCalls += 1;
        assert.deepEqual(identity, { telegramUserId: '123', chatId: '123' });
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
    });

    const result = await handler.handleUpdate(message(`/start ${'c'.repeat(43)}`));

    assert.deepEqual(result, { handled: true });
    assert.equal(fallbackCalls, 1);
    assert.equal(sent.length, 1);
  });

  it('does not call the Bot API when the access gate denies linking', async () => {
    const { handler, sent } = fixture({
      async completeLink() {
        throw new TelegramLinkError('access denied', 403, 'access_denied');
      },
      async findAuthorizedConnection() {
        assert.fail('access denial must not fall through to menu delivery');
      },
    });

    const result = await handler.handleUpdate(message(`/start ${'d'.repeat(43)}`));

    assert.deepEqual(result, { ignored: true });
    assert.deepEqual(sent, []);
  });

  it('opens settings through an authorized read-only callback and answers it first', async () => {
    const calls = [];
    const { answered, edited, handler } = fixture({
      async findAuthorizedConnection(identity) {
        calls.push(['access', identity]);
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
    });

    const result = await handler.handleUpdate({
      callback_query: {
        id: 'callback-1',
        data: 'ts1:c:s',
        from: { id: 123 },
        message: {
          message_id: 44,
          chat: { id: 123, type: 'private' },
        },
      },
    });

    assert.deepEqual(result, { handled: true });
    assert.equal(calls[0][0], 'access');
    assert.deepEqual(answered, [{ callback_query_id: 'callback-1' }]);
    assert.equal(edited[0].message_id, 44);
    assert.match(edited[0].text, /Alerts \/ Solana/);
  });

  it('does not answer malformed or unauthorized callbacks', async () => {
    const denied = fixture({
      async findAuthorizedConnection() {
        throw new TelegramLinkError('denied', 403, 'access_denied');
      },
    });
    const malformed = await denied.handler.handleUpdate({
      callback_query: { id: 'x', data: 'ts1:r:s:claim' },
    });
    const unauthorized = await denied.handler.handleUpdate({
      callback_query: {
        id: 'y',
        data: 'ts1:m',
        from: { id: 123 },
        message: { message_id: 1, chat: { id: 123, type: 'private' } },
      },
    });

    assert.deepEqual(malformed, { ignored: true });
    assert.deepEqual(unauthorized, { ignored: true });
    assert.deepEqual(denied.answered, []);
    assert.deepEqual(denied.edited, []);
  });

  it('applies a versioned mutation and redraws its read-only target', async () => {
    const mutations = [];
    const { answered, edited, handler } = fixture({
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
    }, { mutations });
    const result = await handler.handleUpdate({
      callback_query: {
        id: 'mutation-1',
        data: 'ts1:t:s:v:5',
        from: { id: 123 },
        message: { message_id: 45, chat: { id: 123, type: 'private' } },
      },
    });

    assert.deepEqual(result, { handled: true });
    assert.equal(mutations[0][0], 7);
    assert.equal(mutations[0][1].version, 5);
    assert.equal(answered[0].text, 'Settings updated.');
    assert.match(edited[0].text, /Solana \/ Volume 5M/);
  });

  it('starts a versioned numeric edit with a private force-reply prompt', async () => {
    const { answered, handler, inputCalls, sent } = fixture({
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
    });

    await handler.handleUpdate({
      callback_query: {
        id: 'edit-1',
        data: 'ts1:e:s:v:t:5',
        from: { id: 123 },
        message: { message_id: 48, chat: { id: 123, type: 'private' } },
      },
    });

    assert.equal(inputCalls[0][1].field, 'thresholdPct');
    assert.equal(inputCalls[0][1].expectedVersion, 5);
    assert.deepEqual(answered, [{ callback_query_id: 'edit-1' }]);
    assert.equal(sent[0].reply_markup.force_reply, true);
  });

  it('routes numeric replies and /cancel through the isolated input service', async () => {
    const { handler, inputCalls, sent } = fixture({
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
    }, {
      inputSubmitResult: {
        route: { kind: 'rule', chain: 'solana', ruleKey: 'monitored-vol' },
      },
      settingsContext: {
        rule: {
          enabled: true,
          version: 6,
          settings_json: {
            defaultsVersion: 1,
            thresholdPct: 75,
            cooldownMinutes: 1,
            minVolumeUsd: 10_000,
          },
        },
      },
    });

    await handler.handleUpdate(message('75'));
    await handler.handleUpdate(message('/cancel'));

    assert.equal(inputCalls[0][0], 'submit');
    assert.equal(inputCalls[0][1].text, '75');
    assert.equal(inputCalls[1][0], 'cancel');
    assert.match(sent[0].text, /Threshold: 75%/);
    assert.equal(sent[1].text, 'Edit canceled.');
  });

  it('opens help and account status through commands using fresh access', async () => {
    const { handler, sent } = fixture({
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: {
            chat_id: '123',
            status: 'active',
            user_id: 7,
            last_delivery_at: '2026-07-29T15:00:00.000Z',
          },
        };
      },
    });

    await handler.handleUpdate(message('/help'));
    await handler.handleUpdate(message('/status'));

    assert.match(sent[0].text, /Telegram settings are independent/);
    assert.match(sent[1].text, /Access: Active/);
    assert.match(sent[1].text, /Last delivery: 2026-07-29/);
  });

  it('makes /pause and /resume explicit and idempotent', async () => {
    const cases = [
      ['active', '/pause', 'paused', true],
      ['paused', '/resume', 'active', true],
      ['paused', '/pause', 'paused', false],
    ];
    for (const [initial, command, expected, changes] of cases) {
      const mutations = [];
      const { handler, sent } = fixture({
        async findAuthorizedConnection() {
          return {
            access: { hasProductAccess: true },
            connection: {
              chat_id: '123', status: initial, user_id: 7, version: 4,
            },
          };
        },
      }, {
        mutations,
        mutationResult: {
          chat_id: '123', status: expected, user_id: 7, version: 5,
        },
      });

      await handler.handleUpdate(message(command));

      assert.equal(mutations.length, changes ? 1 : 0);
      if (changes) {
        assert.equal(mutations[0][1].kind, 'set-connection-status');
        assert.equal(mutations[0][1].status, expected);
      }
      assert.match(sent[0].text, new RegExp(
        `Status: ${expected === 'paused' ? 'Paused' : 'Active'}`
      ));
    }
  });

  it('disconnects only after a versioned confirmation callback', async () => {
    const disconnects = [];
    const linkService = {
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: {
            id: '12', chat_id: '123', status: 'active', user_id: 7, version: 4,
          },
        };
      },
      async disconnect(userId, expected) {
        disconnects.push([userId, expected]);
      },
    };
    const { answered, edited, handler, sent } = fixture(linkService);

    await handler.handleUpdate(message('/disconnect'));
    assert.equal(disconnects.length, 0);
    assert.match(sent[0].text, /Disconnect Telegram/);

    await handler.handleUpdate({
      callback_query: {
        id: 'disconnect-1',
        data: sent[0].reply_markup.inline_keyboard[0][0].callback_data,
        from: { id: 123 },
        message: { message_id: 50, chat: { id: 123, type: 'private' } },
      },
    });

    assert.deepEqual(disconnects, [[7, {
      connectionId: '12',
      expectedVersion: 4,
    }]]);
    assert.deepEqual(answered, [{ callback_query_id: 'disconnect-1' }]);
    assert.match(edited[0].text, /Telegram disconnected/);
    assert.deepEqual(edited[0].reply_markup.inline_keyboard, []);
  });

  it('redraws a paused connection from the mutation result instead of stale state', async () => {
    const { edited, handler } = fixture({
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: {
            chat_id: '123', status: 'active', user_id: 7, version: 7,
          },
        };
      },
    }, {
      mutationResult: {
        chat_id: '123', status: 'paused', user_id: 7, version: 8,
      },
    });

    await handler.handleUpdate({
      callback_query: {
        id: 'pause-1',
        data: 'ts1:u:7',
        from: { id: 123 },
        message: { message_id: 46, chat: { id: 123, type: 'private' } },
      },
    });

    assert.match(edited[0].text, /Status: Paused/);
    assert.equal(
      edited[0].reply_markup.inline_keyboard[1][0].text,
      '▶️ Resume deliveries'
    );
  });

  it('reports a stale callback and redraws current server values', async () => {
    const { answered, edited, handler } = fixture({
      async findAuthorizedConnection() {
        return {
          access: { hasProductAccess: true },
          connection: { chat_id: '123', status: 'active', user_id: 7 },
        };
      },
    }, { mutationError: new TelegramSettingsConflictError() });

    await handler.handleUpdate({
      callback_query: {
        id: 'stale-1',
        data: 'ts1:p:s:2',
        from: { id: 123 },
        message: { message_id: 46, chat: { id: 123, type: 'private' } },
      },
    });

    assert.equal(answered[0].show_alert, true);
    assert.match(answered[0].text, /menu was outdated/);
    assert.match(edited[0].text, /Alerts \/ Solana/);
  });
});
