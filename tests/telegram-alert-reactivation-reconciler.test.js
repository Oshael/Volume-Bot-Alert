const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const candidateModel = require('../src/models/telegram-alert-reactivation-candidate');
const {
  createTelegramAlertReactivationReconciler,
} = require('../src/services/telegram-alert-reactivation-reconciler');

const NOW = new Date('2026-08-01T18:00:00.000Z');
const REQUESTED_AT = new Date('2026-08-01T17:59:00.000Z');

function candidate(id, accessStatus = 'active') {
  return {
    connectionId: String(id),
    requestedAt: null,
    user: { id, is_active: true, access_status: accessStatus },
  };
}

describe('Telegram alert reactivation candidate model', () => {
  it('selects only suspended connections without an enabled Solana profile', async () => {
    const calls = [];
    const result = await candidateModel.listWithoutEnabledSolana({ limit: 25 }, {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{
          connection_id: '20',
          access_reactivation_requested_at: null,
          user_id: 7,
          user_role: 'user',
          user_is_active: true,
          access_status: 'active',
        }] };
      },
    });

    assert.match(calls[0].sql, /status = 'access_suspended'/);
    assert.match(calls[0].sql, /NOT EXISTS[\s\S]+chain = 'solana'[\s\S]+enabled = TRUE/);
    assert.deepEqual(calls[0].params, [25]);
    assert.equal(result[0].connectionId, '20');
    assert.equal(result[0].user.id, 7);
  });
});

describe('Telegram alert reactivation reconciler', () => {
  it('reactivates recovered access through the guarded no-Solana transition', async () => {
    const calls = [];
    const instance = createTelegramAlertReactivationReconciler({
      batchSize: 10,
      candidateModel: {
        async listWithoutEnabledSolana(input) {
          calls.push(['list', input]);
          return [candidate(7)];
        },
      },
      async accessResolver(user, now, deps) {
        calls.push(['access', user.id, now, deps]);
        return { hasProductAccess: true };
      },
      accessDeps: { source: 'test' },
      stateRepository: {
        async requestReactivation(input) {
          calls.push(['request', input]);
          return { connectionId: input.connectionId, requestedAt: REQUESTED_AT };
        },
        async completeReactivationWithoutEnabledSolana(input) {
          calls.push(['complete', input]);
          return { connectionId: input.connectionId, status: 'active' };
        },
      },
    });

    assert.deepEqual(await instance.reconcile({ now: NOW }), {
      scanned: 1, denied: 0, reactivated: 1, deferred: 0, errors: 0,
    });
    assert.deepEqual(calls, [
      ['list', { limit: 10 }],
      ['access', 7, NOW, { source: 'test' }],
      ['request', { connectionId: '7', userId: 7 }],
      ['complete', { connectionId: '7', userId: 7, requestedAt: REQUESTED_AT }],
    ]);
  });

  it('leaves denied or concurrently changed candidates suspended', async () => {
    const mutations = [];
    const errors = [];
    const instance = createTelegramAlertReactivationReconciler({
      candidateModel: {
        async listWithoutEnabledSolana() {
          return [candidate(7, 'expired'), candidate(8), candidate(9)];
        },
      },
      async accessResolver(user) {
        if (user.id === 9) throw new Error('access lookup failed');
        return { hasProductAccess: user.access_status === 'active' };
      },
      stateRepository: {
        async requestReactivation(input) {
          mutations.push(['request', input.connectionId]);
          return { requestedAt: REQUESTED_AT };
        },
        async completeReactivationWithoutEnabledSolana(input) {
          mutations.push(['complete', input.connectionId]);
          return null;
        },
      },
      async onCandidateError(input) { errors.push(input); },
    });

    assert.deepEqual(await instance.reconcile({ now: NOW }), {
      scanned: 3, denied: 1, reactivated: 0, deferred: 1, errors: 1,
    });
    assert.deepEqual(mutations, [['request', '8'], ['complete', '8']]);
    assert.equal(errors[0].candidate.connectionId, '9');
  });
});
