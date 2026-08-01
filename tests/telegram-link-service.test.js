const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  LINK_TTL_MS,
  TelegramLinkError,
  createTelegramLinkService,
} = require('../src/services/telegram-link-service');

function fixture(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT id, role, is_active')) {
        calls.push(`lock:${params[0]}`);
        return { rows: [options.lockedUser || { id: params[0], is_active: true }] };
      }
      calls.push(sql);
      return { rows: [] };
    },
    release() {
      calls.push('RELEASE');
    },
  };
  const connection = options.connection || null;
  const connectionModel = {
    async findActiveByUserId(userId) {
      calls.push(`find:${userId}`);
      return connection;
    },
    async disconnect(id) {
      calls.push(`disconnect:${id}:${arguments[2]}`);
      return options.disconnectConflict ? null : { id };
    },
    async findActiveByTelegramUserId(telegramUserId) {
      calls.push(`findTelegram:${telegramUserId}`);
      return options.telegramConnection || null;
    },
    async create(input) {
      calls.push(
        `link:${input.userId}:${input.telegramUserId}:${input.chatId}:${input.languageCode}`
      );
      return {
        id: 20,
        user_id: input.userId,
        telegram_user_id: input.telegramUserId,
        chat_id: input.chatId,
        status: 'active',
        language_code: input.languageCode,
      };
    },
    async updateLanguageCode(input) {
      calls.push(`language:${input.id}:${input.languageCode}`);
      return options.languageUpdateConflict ? null : {
        ...options.telegramConnection,
        language_code: input.languageCode,
      };
    },
  };
  const linkTokenModel = {
    async revokeForUser(userId) {
      calls.push(`revoke:${userId}`);
    },
    async create(input) {
      calls.push(`create:${input.userId}:${input.expiresAt.toISOString()}`);
      return { token: 'opaque/+token' };
    },
    async consume(token) {
      calls.push(`consume:${token}`);
      return options.tokenRecord || null;
    },
  };
  const inputSessionModel = {
    async clear(input) {
      calls.push(`clear:${input.userId}:${input.telegramUserId}`);
      return 1;
    },
  };
  const profileModel = {
    async bindConnection(input) {
      calls.push(`profiles:${input.userId}:${input.connectionId}`);
      if (options.profileError) throw options.profileError;
      return options.profiles || [
        { id: 10, chain: 'robinhood' },
        { id: 11, chain: 'solana' },
      ];
    },
  };
  const ruleSettingModel = {
    async ensureDefaults(profiles) {
      calls.push(`defaults:${profiles.map((profile) => profile.id).join(',')}`);
      if (options.ruleDefaultsError) throw options.ruleDefaultsError;
      return [];
    },
  };
  const service = createTelegramLinkService({
    settings: options.settings || { enabled: true, botUsername: '@trend_scope_bot' },
    database: { getClient: async () => client },
    connectionModel,
    inputSessionModel,
    linkTokenModel,
    profileModel,
    ruleSettingModel,
    userModel: {
      async findById(userId) {
        calls.push(`user:${userId}`);
        return options.user || { id: userId, is_active: true };
      },
    },
    accessResolver: async (user) => {
      calls.push(`access:${user.id}`);
      return options.access || { hasProductAccess: true };
    },
    now: () => new Date('2026-07-29T12:00:00.000Z'),
  });
  return { calls, service };
}

describe('Telegram link service', () => {
  it('returns a minimal status without exposing Telegram IDs', async () => {
    const { service } = fixture({
      connection: {
        status: 'active',
        telegram_user_id: '123',
        chat_id: '456',
        username: 'alice',
        first_name: 'Alice',
        linked_at: '2026-07-29T11:00:00.000Z',
      },
    });

    const status = await service.getStatus(7);
    assert.deepEqual(status.identity, { username: 'alice', firstName: 'Alice' });
    assert.equal(status.botUrl, 'https://t.me/trend_scope_bot');
    assert.equal(JSON.stringify(status).includes('123'), false);
    assert.equal(JSON.stringify(status).includes('456'), false);
  });

  it('creates one short-lived link inside a transaction', async () => {
    const { calls, service } = fixture();
    const result = await service.createLink(7);

    assert.equal(result.deepLink, 'https://t.me/trend_scope_bot?start=opaque%2F%2Btoken');
    assert.equal(
      new Date(result.expiresAt).getTime() - new Date('2026-07-29T12:00:00.000Z').getTime(),
      LINK_TTL_MS
    );
    assert.deepEqual(calls, [
      'BEGIN',
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      'find:7',
      'revoke:7',
      'create:7:2026-07-29T12:10:00.000Z',
      'COMMIT',
      'RELEASE',
    ]);
  });

  it('blocks silent replacement and rolls the transaction back', async () => {
    const { calls, service } = fixture({ connection: { id: 12, status: 'active' } });
    await assert.rejects(service.createLink(7), (error) => {
      assert.ok(error instanceof TelegramLinkError);
      assert.equal(error.status, 409);
      return true;
    });
    assert.deepEqual(calls, [
      'BEGIN', 'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      'find:7', 'ROLLBACK', 'RELEASE',
    ]);
  });

  it('refuses link creation while the integration is disabled', async () => {
    const { service } = fixture({ settings: { enabled: false, botUsername: 'bot' } });
    await assert.rejects(service.createLink(7), { status: 503 });
  });

  it('disconnects idempotently and revokes pending links', async () => {
    const { calls, service } = fixture({
      connection: {
        id: 12,
        status: 'paused',
        telegram_user_id: '123',
        version: 4,
      },
    });
    const status = await service.disconnect(7, {
      connectionId: '12',
      expectedVersion: 4,
    });
    assert.equal(status.status, 'disconnected');
    assert.deepEqual(calls, [
      'BEGIN', 'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      'find:7', 'disconnect:12:4', 'clear:7:123',
      'revoke:7', 'COMMIT', 'RELEASE',
    ]);
  });

  it('rolls back a stale disconnect confirmation without touching the new link', async () => {
    const { calls, service } = fixture({
      connection: { id: 13, status: 'active', telegram_user_id: '123', version: 1 },
    });

    await assert.rejects(
      () => service.disconnect(7, { connectionId: '12', expectedVersion: 4 }),
      { code: 'connection_conflict', status: 409 }
    );
    assert.equal(calls.some((entry) => entry.startsWith('disconnect:')), false);
    assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  });

  it('consumes the token and creates one private link atomically after the access gate', async () => {
    const token = 'a'.repeat(43);
    const { calls, service } = fixture({ tokenRecord: { user_id: 7 } });

    const result = await service.completeLink({
      token,
      telegramUserId: 123,
      chatId: 123,
      username: 'alice',
      firstName: 'Alice',
      languageCode: 'pt_br',
    });

    assert.equal(result.connection.user_id, 7);
    assert.deepEqual(calls, [
      'BEGIN',
      `consume:${token}`,
      'lock:7',
      'access:7',
      'find:7',
      'findTelegram:123',
      'link:7:123:123:pt-BR',
      'profiles:7:20',
      'defaults:10,11',
      'COMMIT',
      'RELEASE',
    ]);
  });

  it('rolls the connection back when its independent profiles cannot be bound', async () => {
    const { calls, service } = fixture({
      tokenRecord: { user_id: 7 },
      profileError: new Error('profile bind failed'),
    });

    await assert.rejects(
      () => service.completeLink({
        token: 'c'.repeat(43),
        telegramUserId: 123,
        chatId: 123,
      }),
      /profile bind failed/
    );
    assert.equal(calls.includes('profiles:7:20'), true);
    assert.equal(calls.includes('COMMIT'), false);
    assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  });

  it('rolls the connection back when rule defaults cannot be created', async () => {
    const { calls, service } = fixture({
      tokenRecord: { user_id: 7 },
      ruleDefaultsError: new Error('rule defaults failed'),
    });
    await assert.rejects(
      () => service.completeLink({
        token: 'd'.repeat(43),
        telegramUserId: 123,
        chatId: 123,
      }),
      /rule defaults failed/
    );
    assert.equal(calls.includes('COMMIT'), false);
    assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  });

  it('rolls back without creating a connection when access is unavailable', async () => {
    const { calls, service } = fixture({
      tokenRecord: { user_id: 7 },
      access: { hasProductAccess: false },
    });

    await assert.rejects(
      () => service.completeLink({
        token: 'b'.repeat(43),
        telegramUserId: 123,
        chatId: 123,
      }),
      { code: 'access_denied', status: 403 }
    );
    assert.equal(calls.some((entry) => entry.startsWith('link:')), false);
    assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  });

  it('revalidates access before returning an existing connection to a command', async () => {
    const { service } = fixture({
      telegramConnection: {
        id: 20,
        user_id: 7,
        telegram_user_id: '123',
        chat_id: '123',
        status: 'active',
      },
      access: { hasProductAccess: false },
    });

    await assert.rejects(
      () => service.findAuthorizedConnection({
        telegramUserId: 123,
        chatId: 123,
      }),
      { code: 'access_denied', status: 403 }
    );
  });

  it('refreshes a changed language code after access is revalidated', async () => {
    const { calls, service } = fixture({
      telegramConnection: {
        id: 20,
        user_id: 7,
        telegram_user_id: '123',
        chat_id: '123',
        status: 'active',
        language_code: 'en',
      },
    });

    const result = await service.findAuthorizedConnection({
      telegramUserId: 123,
      chatId: 123,
      languageCode: 'pt_br',
    });

    assert.equal(result.connection.language_code, 'pt-BR');
    assert.ok(calls.includes('language:20:pt-BR'));
  });
});
