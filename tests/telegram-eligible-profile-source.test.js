const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const candidateModel = require('../src/models/telegram-alert-evaluation-candidate');
const {
  createTelegramEligibleProfileSource,
} = require('../src/services/telegram-eligible-profile-source');

function row(ruleKey, overrides = {}) {
  return {
    profile_id: '10',
    user_id: 7,
    connection_id: '20',
    chain: 'solana',
    profile_enabled: true,
    sparkline_enabled: true,
    profile_version: 2,
    profile_updated_at: '2026-07-29T15:00:00.000Z',
    user_role: 'user',
    user_is_active: true,
    access_status: 'active',
    access_granted_at: '2026-07-01T00:00:00.000Z',
    access_expires_at: null,
    access_source: 'payment',
    access_updated_at: '2026-07-01T00:00:00.000Z',
    rule_key: ruleKey,
    rule_enabled: true,
    settings_json: { cooldownMinutes: 10 },
    rule_version: 1,
    rule_updated_at: '2026-07-29T15:00:00.000Z',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    profile: {
      id: '10',
      user_id: 7,
      connection_id: '20',
      chain: 'solana',
      enabled: true,
    },
    user: {
      id: 7,
      role: 'user',
      is_active: true,
      access_status: 'active',
    },
    rules: [{ profile_id: '10', rule_key: 'monitored-vol' }],
    ...overrides,
  };
}

describe('Telegram alert evaluation candidate model', () => {
  it('loads active candidates in one query and groups their rule rows', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [
            row('monitored-mcap'),
            row('monitored-vol'),
            row('monitored-vol', {
              profile_id: '11',
              connection_id: '21',
              user_id: 8,
            }),
          ],
        };
      },
    };

    const result = await candidateModel.listByChain('solana', database);

    assert.deepEqual(calls[0].params, ['solana']);
    assert.match(calls[0].sql, /profiles\.enabled = TRUE/);
    assert.match(calls[0].sql, /connections\.status = 'active'/);
    assert.match(calls[0].sql, /users\.is_active = TRUE/);
    assert.equal(result.length, 2);
    assert.equal(result[0].profile.id, '10');
    assert.equal(result[0].user.access_status, 'active');
    assert.deepEqual(
      result[0].rules.map((rule) => rule.rule_key),
      ['monitored-mcap', 'monitored-vol']
    );
    assert.equal(result[1].profile.user_id, 8);
  });

  it('rejects unsupported chains before querying', async () => {
    let queried = false;
    await assert.rejects(
      candidateModel.listByChain('base', {
        async query() {
          queried = true;
          return { rows: [] };
        },
      }),
      /Unsupported Telegram alert chain/
    );
    assert.equal(queried, false);
  });
});

describe('Telegram eligible profile source', () => {
  it('caches candidate configuration but resolves access on every discovery', async () => {
    let repositoryCalls = 0;
    let accessCalls = 0;
    const source = createTelegramEligibleProfileSource({
      cacheTtlMs: 5_000,
      now: () => 1_000,
      candidateModel: {
        async listByChain() {
          repositoryCalls += 1;
          return [candidate()];
        },
      },
      async accessResolver(user, now) {
        accessCalls += 1;
        assert.equal(user.id, 7);
        assert.equal(now.toISOString(), '1970-01-01T00:00:01.000Z');
        return { hasProductAccess: accessCalls === 1 };
      },
    });

    const first = await source.listEligible({ chain: 'solana' });
    const second = await source.listEligible({ chain: 'solana' });

    assert.equal(first.length, 1);
    assert.deepEqual(Object.keys(first[0]).sort(), ['profile', 'rules']);
    assert.equal(second.length, 0);
    assert.equal(repositoryCalls, 1);
    assert.equal(accessCalls, 2);
  });

  it('fails closed per user while preserving other eligible profiles', async () => {
    const errors = [];
    const source = createTelegramEligibleProfileSource({
      candidateModel: {
        async listByChain() {
          return [
            candidate(),
            candidate({
              profile: { ...candidate().profile, id: '11', user_id: 8 },
              user: { ...candidate().user, id: 8 },
            }),
            candidate({
              profile: { ...candidate().profile, id: '12', user_id: 9 },
              user: { ...candidate().user, id: 9, is_active: false },
            }),
          ];
        },
      },
      async accessResolver(user) {
        if (user.id === 7) throw new Error('access backend unavailable');
        return { hasProductAccess: true };
      },
      async onAccessError(input) {
        errors.push(input);
      },
    });

    const result = await source.listEligible({
      chain: 'solana',
      nowMs: Date.UTC(2026, 6, 29),
    });

    assert.deepEqual(result.map(({ profile }) => profile.id), ['11']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].candidate.user.id, 7);
  });

  it('reloads cached configuration after explicit invalidation or TTL expiry', async () => {
    let repositoryCalls = 0;
    const source = createTelegramEligibleProfileSource({
      cacheTtlMs: 10,
      candidateModel: {
        async listByChain() {
          repositoryCalls += 1;
          return [candidate()];
        },
      },
      async accessResolver() {
        return { hasProductAccess: true };
      },
    });

    await source.listEligible({ chain: 'solana', nowMs: 100 });
    await source.listEligible({ chain: 'solana', nowMs: 105 });
    source.invalidate('solana');
    await source.listEligible({ chain: 'solana', nowMs: 106 });
    await source.listEligible({ chain: 'solana', nowMs: 117 });

    assert.equal(repositoryCalls, 3);
  });
});
