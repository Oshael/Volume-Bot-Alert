const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertAccessStateRepository,
} = require('../src/models/telegram-alert-access-state');
const {
  createTelegramAlertAccessGate,
} = require('../src/services/telegram-alert-access-gate');

const NOW = new Date('2026-08-01T15:00:00.000Z');

function context(overrides = {}) {
  const base = {
    connection: { id: '20', status: 'active' },
    profile: { id: '10', enabled: true },
    user: { id: 7, is_active: true, access_status: 'active' },
  };
  return {
    ...base,
    ...overrides,
    connection: { ...base.connection, ...overrides.connection },
    profile: { ...base.profile, ...overrides.profile },
    user: { ...base.user, ...overrides.user },
  };
}

function gate(options = {}) {
  const calls = { access: [], reactivate: [], suspend: [] };
  const instance = createTelegramAlertAccessGate({
    async accessResolver(user, now, deps) {
      calls.access.push({ user, now, deps });
      return options.access || { hasProductAccess: true };
    },
    repository: {
      async suspend(input) { calls.suspend.push(input); return { suspended: true }; },
      async requestReactivation(input) {
        calls.reactivate.push(input);
        return { requestedAt: NOW };
      },
    },
    accessDeps: { source: 'test' },
  });
  return { calls, instance };
}

describe('Telegram alert access gate', () => {
  it('authorizes an active profile only after resolving current product access', async () => {
    const { calls, instance } = gate();

    assert.deepEqual(await instance.authorize({ context: context(), now: NOW }), {
      allowed: true,
    });
    assert.equal(calls.access.length, 1);
    assert.equal(calls.access[0].now, NOW);
    assert.deepEqual(calls.access[0].deps, { source: 'test' });
    assert.equal(calls.suspend.length, 0);
  });

  it('suspends inactive accounts without consulting token access', async () => {
    const { calls, instance } = gate();
    const result = await instance.authorize({
      context: context({ user: { is_active: false } }), now: NOW,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.code, 'account_inactive');
    assert.equal(calls.access.length, 0);
    assert.deepEqual(calls.suspend[0], {
      connectionId: '20', userId: 7, errorCode: 'account_inactive',
      error: 'TrendScope account is inactive',
    });
  });

  it('persists resolved access denial and preserves its public reason', async () => {
    const { calls, instance } = gate({
      access: {
        hasProductAccess: false,
        denialCode: 'access_expired',
        denialReason: 'Access expired',
      },
    });
    const result = await instance.authorize({ context: context(), now: NOW });

    assert.equal(result.code, 'access_expired');
    assert.equal(calls.suspend[0].errorCode, 'access_expired');
    assert.equal(calls.suspend[0].error, 'Access expired');
  });

  it('blocks paused, disabled and disconnected destinations before access resolution', async () => {
    for (const [overrides, code] of [
      [{ connection: { status: 'paused' } }, 'telegram_paused'],
      [{ profile: { enabled: false } }, 'telegram_profile_disabled'],
      [{ connection: { status: 'disconnected' } }, 'telegram_disconnected'],
    ]) {
      const { calls, instance } = gate();
      const result = await instance.authorize({ context: context(overrides), now: NOW });
      assert.equal(result.code, code);
      assert.equal(calls.access.length, 0);
      assert.equal(calls.suspend.length, 0);
    }
  });

  it('does not replay a recovered suspended connection before reactivation', async () => {
    const { calls, instance } = gate();
    const result = await instance.authorize({
      context: context({ connection: { status: 'access_suspended' } }), now: NOW,
    });

    assert.equal(result.code, 'access_reactivation_pending');
    assert.equal(calls.access.length, 1);
    assert.equal(calls.suspend.length, 0);
    assert.deepEqual(calls.reactivate, [{ connectionId: '20', userId: 7 }]);
  });
});

describe('Telegram alert access state repository', () => {
  it('locks the connection and atomically suspends it before cancelling backlog', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/SELECT status/.test(sql)) return { rows: [{ status: 'active' }] };
        if (/UPDATE telegram_connections/.test(sql)) return { rowCount: 1 };
        if (/UPDATE telegram_alert_deliveries/.test(sql)) return { rowCount: 2 };
        return { rowCount: 0, rows: [] };
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const repository = createTelegramAlertAccessStateRepository({
      database: {
        async getClient() { return client; },
        async query(sql, params) { return client.query(sql, params); },
      },
    });

    const result = await repository.suspend({
      connectionId: 20, userId: 7, errorCode: 'access_expired', error: 'Access expired',
    });

    assert.deepEqual(result, { status: 'active', suspended: true, cancelled: 2 });
    assert.equal(calls[0].sql, 'BEGIN');
    assert.match(calls[1].sql, /FOR UPDATE/);
    assert.match(calls[2].sql, /status = 'access_suspended'/);
    assert.match(calls[3].sql, /status IN \('pending', 'retry'\)/);
    assert.deepEqual(calls[3].params, ['20', 'access_expired', 'Access expired']);
    assert.equal(calls[4].sql, 'COMMIT');
    assert.equal(calls[5].sql, 'RELEASE');
  });
});
