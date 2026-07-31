const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const deliveryModel = require('../src/models/telegram-alert-delivery');
const {
  createTelegramAlertPlanCommitter,
} = require('../src/services/telegram-alert-plan-committer');
const TOKEN = '11111111111111111111111111111111';
function intent() {
  return {
    intentRef: 'intent:1',
    connectionId: '20',
    profileId: '10',
    chain: 'solana',
    ruleKey: 'monitored-vol',
    kind: 'monitored-vol',
    tokenAddress: TOKEN,
    dedupeKey: 'profile:10:signal:1',
    payload: { symbol: 'TEST', volume5m: 20_000 },
    triggeredAt: '2026-07-29T15:00:00.000Z',
  };
}
function plan() {
  return {
    profileId: '10',
    connectionId: '20',
    intents: [intent()],
    stateTransitions: [{
      profileId: '10',
      chain: 'solana',
      ruleKey: 'monitored-vol',
      tokenAddress: TOKEN,
      ruleVersion: 3,
      expectedVersion: null,
      state: {
        status: 'triggered',
        metadata: { lastDecision: 'triggered', lastEventId: null },
      },
      eventReferences: [{
        field: 'metadata.lastEventId',
        intentRef: 'intent:1',
      }],
    }],
  };
}
function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(String(sql));
      return { rows: [] };
    },
    release() { calls.push('RELEASE'); },
  };
}
function delivery(id = '41', created = true) {
  return { created, delivery: { id, status: 'pending' } };
}
describe('Telegram alert delivery model', () => {
  it('creates an immutable pending delivery with normalized bigint identities', async () => {
    const calls = [];
    const db = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            id: '41',
            connection_id: '20',
            profile_id: '10',
            rule_key: 'monitored-vol',
            chain: 'solana',
            token_address: TOKEN,
            dedupe_key: 'profile:10:signal:1',
            event_payload: { kind: 'monitored-vol', payload: { symbol: 'TEST' } },
            status: 'pending',
            attempts: 0,
          }],
        };
      },
    };
    const result = await deliveryModel.createPending({
      ...intent(),
      payload: { symbol: 'TEST' },
    }, db);
    assert.equal(result.created, true);
    assert.equal(result.delivery.id, '41');
    assert.match(calls[0].sql, /ON CONFLICT \(connection_id, dedupe_key\) DO NOTHING/);
    assert.deepEqual(calls[0].params.slice(0, 6), [
      '20', '10', 'monitored-vol', 'solana', TOKEN, 'profile:10:signal:1',
    ]);
    assert.deepEqual(JSON.parse(calls[0].params[6]), {
      kind: 'monitored-vol',
      payload: { symbol: 'TEST' },
    });
  });

  it('returns an identical duplicate and rejects a conflicting dedupe key', async () => {
    const input = intent();
    const duplicateDb = {
      calls: 0,
      async query() {
        this.calls += 1;
        if (this.calls === 1) return { rows: [] };
        return {
          rows: [{ id: '41', connection_id: '20', profile_id: '10', attempts: 0 }],
        };
      },
    };
    assert.equal((await deliveryModel.createPending(input, duplicateDb)).created, false);
    const conflictDb = { async query() { return { rows: [] }; } };
    await assert.rejects(
      () => deliveryModel.createPending(input, conflictDb),
      { code: 'delivery_conflict' }
    );
  });

  it('claims due and expired deliveries with skip-locked lease ownership', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            id: '41',
            connection_id: '20',
            profile_id: '10',
            status: 'claimed',
            attempts: 2,
            lease_owner: 'worker-a',
            lease_until: '2026-07-29T15:01:00.000Z',
          }],
        };
      },
    };

    const result = await deliveryModel.claimReadyBatch({
      owner: 'worker-a',
      limit: 12,
      leaseMs: 45_000,
    }, database);

    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(
      calls[0].sql,
      /status = 'claimed' AND lease_until <= NOW\(\)/
    );
    assert.match(calls[0].sql, /attempts = deliveries\.attempts \+ 1/);
    assert.deepEqual(calls[0].params, [12, 'worker-a', 45_000]);
    assert.equal(result[0].id, '41');
    assert.equal(result[0].attempts, 2);
    assert.equal(result[0].leaseOwner, 'worker-a');
  });

  it('renews only live claims owned by the requesting worker', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            id: '41',
            status: 'claimed',
            attempts: 1,
            lease_owner: 'worker-a',
          }],
        };
      },
    };

    const result = await deliveryModel.renewClaims({
      ids: ['41', 42, '41'],
      owner: 'worker-a',
      leaseMs: 30_000,
    }, database);

    assert.match(calls[0].sql, /id = ANY\(\$1::bigint\[\]\)/);
    assert.match(calls[0].sql, /lease_owner = \$2/);
    assert.match(calls[0].sql, /lease_until > NOW\(\)/);
    assert.deepEqual(calls[0].params, [['41', '42'], 'worker-a', 30_000]);
    assert.equal(result[0].leaseOwner, 'worker-a');
  });

  it('rejects invalid claim ownership before querying', async () => {
    let queries = 0;
    const database = {
      async query() {
        queries += 1;
        return { rows: [] };
      },
    };

    await assert.rejects(
      () => deliveryModel.claimReadyBatch({ owner: '', limit: 1 }, database),
      /lease owner/
    );
    await assert.rejects(
      () => deliveryModel.renewClaims({ owner: 'worker-a', ids: [] }, database),
      /claim ids/
    );
    assert.equal(queries, 0);
  });

  it('settles only a live claim owned by the requesting worker', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            id: '41',
            status: params[2],
            attempts: 1,
            next_attempt_at: params[3],
            lease_owner: null,
            lease_until: null,
            last_error_code: params[6],
          }],
        };
      },
    };

    const result = await deliveryModel.scheduleRetry({
      id: '41',
      owner: 'worker-a',
      nextAttemptAt: '2026-07-29T15:02:00.000Z',
      errorCode: 'api_unavailable',
      error: 'Telegram unavailable',
    }, database);

    assert.match(calls[0].sql, /status = 'claimed'/);
    assert.match(calls[0].sql, /lease_owner = \$2/);
    assert.match(calls[0].sql, /lease_until > NOW\(\)/);
    assert.match(calls[0].sql, /lease_owner = NULL/);
    assert.deepEqual(calls[0].params, [
      '41',
      'worker-a',
      'retry',
      '2026-07-29T15:02:00.000Z',
      null,
      null,
      'api_unavailable',
      'Telegram unavailable',
    ]);
    assert.equal(result.status, 'retry');
    assert.equal(result.leaseOwner, null);
  });

  it('validates settlement payloads before querying', async () => {
    let queries = 0;
    const database = {
      async query() {
        queries += 1;
        return { rows: [] };
      },
    };

    await assert.rejects(
      () => deliveryModel.markSent({
        id: '41',
        owner: 'worker-a',
        messageId: 0,
      }, database),
      /Telegram message id/
    );
    await assert.rejects(
      () => deliveryModel.scheduleRetry({
        id: '41',
        owner: 'worker-a',
        errorCode: 'timeout',
        error: 'timeout',
        nextAttemptAt: 'invalid',
      }, database),
      /nextAttemptAt/
    );
    assert.equal(queries, 0);
  });
});
describe('Telegram alert plan committer', () => {
  it('commits the intent and resolved state in one transaction', async () => {
    const client = fakeClient();
    let stateInput;
    const committer = createTelegramAlertPlanCommitter({
      database: { async getClient() { return client; } },
      deliveryModel: { async createPending() { return delivery(); } },
      stateModel: {
        async write(input) {
          stateInput = input;
          return { version: 1 };
        },
      },
    });
    const result = await committer.commit(plan());
    assert.equal(stateInput.state.metadata.lastEventId, '41');
    assert.deepEqual(client.calls, ['BEGIN', 'COMMIT', 'RELEASE']);
    assert.equal(result.statesWritten, 1);
    assert.equal(result.duplicate, false);
  });

  it('rolls back both writes on an optimistic state conflict', async () => {
    const client = fakeClient();
    const committer = createTelegramAlertPlanCommitter({
      database: { async getClient() { return client; } },
      deliveryModel: { async createPending() { return delivery(); } },
      stateModel: { async write() { return null; } },
    });
    await assert.rejects(() => committer.commit(plan()), { code: 'state_conflict' });
    assert.deepEqual(client.calls, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  it('treats an identical persisted plan as an idempotent replay', async () => {
    const client = fakeClient();
    let stateWrites = 0;
    const replay = plan();
    replay.stateTransitions.push({
      ...replay.stateTransitions[0],
      ruleKey: 'hvnc',
      state: { status: 'triggered', metadata: { lastDecision: 'primed' } },
      eventReferences: [],
    });
    const committer = createTelegramAlertPlanCommitter({
      database: { async getClient() { return client; } },
      deliveryModel: { async createPending() { return delivery('41', false); } },
      stateModel: { async write() { stateWrites += 1; return { version: 1 }; } },
    });
    const result = await committer.commit(replay);
    assert.equal(result.duplicate, true);
    assert.equal(stateWrites, 1);
    assert.deepEqual(client.calls, ['BEGIN', 'COMMIT', 'RELEASE']);
  });

  it('rejects dangling intents before opening a transaction', async () => {
    let clients = 0;
    const invalid = plan();
    invalid.stateTransitions[0].eventReferences = [];
    const committer = createTelegramAlertPlanCommitter({
      database: { async getClient() { clients += 1; } },
    });
    await assert.rejects(
      () => committer.commit(invalid),
      /Triggered Telegram alert state requires a durable intent/
    );
    assert.equal(clients, 0);
  });
});
