const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertDeliveryContextRepository,
} = require('../src/models/telegram-alert-delivery-context');
const {
  createTelegramAlertDeliveryContextSource,
} = require('../src/services/telegram-alert-delivery-context-source');

const DELIVERY = Object.freeze({
  id: '71',
  connectionId: '20',
  profileId: '10',
  chain: 'solana',
});

function context(overrides = {}) {
  return {
    claim: { deliveryId: '71', connectionId: '20', profileId: '10', chain: 'solana' },
    connection: {
      id: '20', userId: 7, chatId: '9007199254740993', status: 'active',
      languageCode: 'pt-BR',
    },
    profile: {
      id: '10', connectionId: '20', userId: 7, chain: 'solana',
      enabled: true, sparklineEnabled: true,
    },
    user: {
      id: 7, role: 'user', is_active: true, access_status: 'active',
      access_expires_at: '2026-08-29T15:00:00.000Z',
    },
    ...overrides,
  };
}

function source(contextValue = context(), options = {}) {
  return createTelegramAlertDeliveryContextSource({
    sparklineHours: 24,
    sparklineGranularityMinutes: 5,
    repository: { async loadClaim() { return contextValue; } },
    ...options,
  });
}

describe('Telegram alert delivery context', () => {
  it('loads only a currently owned claim and maps its relational context', async () => {
    const calls = [];
    const repository = createTelegramAlertDeliveryContextRepository({
      database: {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [{
            delivery_id: '71', connection_id: '20', profile_id: '10', chain: 'solana',
            user_id: 7, chat_id: '9007199254740993', connection_status: 'active',
            language_code: 'pt-BR',
            profile_enabled: true, sparkline_enabled: true,
            user_role: 'user', user_is_active: true, access_status: 'active',
            access_granted_at: null, access_expires_at: null,
            access_source: 'manual', access_updated_at: null,
          }] };
        },
      },
    });

    const result = await repository.loadClaim({ id: '71', owner: 'worker-a' });

    assert.deepEqual(calls[0].params, ['71', 'worker-a']);
    assert.match(calls[0].sql, /deliveries\.status = 'claimed'/);
    assert.match(calls[0].sql, /deliveries\.lease_owner = \$2/);
    assert.match(calls[0].sql, /deliveries\.lease_until > NOW\(\)/);
    assert.match(calls[0].sql, /profiles\.user_id = connections\.user_id/);
    assert.equal(result.connection.chatId, '9007199254740993');
    assert.equal(result.user.access_status, 'active');
  });

  it('returns null when the lease no longer owns a matching row', async () => {
    const repository = createTelegramAlertDeliveryContextRepository({
      database: { async query() { return { rows: [] }; } },
    });
    assert.equal(await repository.loadClaim({ id: 71, owner: 'worker-a' }), null);
  });

  it('builds sender input while preserving access context for the gate', async () => {
    const result = await source().load({ delivery: DELIVERY, owner: 'worker-a' });

    assert.deepEqual(result.senderInput, {
      chatId: '9007199254740993',
      languageCode: 'pt-BR',
      sparklineEnabled: true,
      sparklineHours: 24,
      sparklineGranularityMinutes: 5,
    });
    assert.equal(result.connection.status, 'active');
    assert.equal(result.profile.enabled, true);
    assert.equal(result.user.access_status, 'active');
  });

  it('omits sparkline policy values for a disabled profile preference', async () => {
    const disabled = context({
      profile: { ...context().profile, sparklineEnabled: false },
    });
    const result = await source(disabled).load({ delivery: DELIVERY, owner: 'worker-a' });

    assert.equal(result.senderInput.sparklineEnabled, false);
    assert.equal(result.senderInput.sparklineHours, null);
    assert.equal(result.senderInput.sparklineGranularityMinutes, null);
  });

  it('rejects mismatched relational identities and unresolved sparkline policy', async () => {
    const mismatched = context({
      claim: { ...context().claim, profileId: '11' },
    });
    await assert.rejects(
      source(mismatched).load({ delivery: DELIVERY, owner: 'worker-a' }),
      /context identity mismatch/,
    );
    assert.throws(
      () => source(context(), { sparklineGranularityMinutes: 2 }),
      /granularity is unsupported/,
    );
  });
});
