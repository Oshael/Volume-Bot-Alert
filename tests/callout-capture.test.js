'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createCalloutCaptureRepository, __private } = require('../src/models/callout-capture');
const { commonCalloutFromPump, createCalloutEnvelope } = require('../src/services/callout-domain');
const {
  createProfileObservation, createProfileObservationEnvelope, walletObservationKey,
} = require('../src/services/profile-wallet-domain');

const CAPTURED_AT = '2026-08-25T12:00:00.000Z';
const EVM = '0xabcdef0123456789abcdef0123456789abcdef01';

function fixture() {
  const profile = createProfileObservation({
    platform: 'pump', platformUserId: 'user-1', username: 'alice', observedAt: CAPTURED_AT,
    source: 'leaderboard', wallets: [{
      address: EVM, rawChainId: '999999', relationType: 'profile_wallet',
      sourceType: 'platform_reported', sourceField: 'walletAddress', confidence: 'high',
    }],
  });
  const callout = commonCalloutFromPump({
    eventKind: 'callout', sourceEventId: 'event-1', sourceCreatedAt: CAPTURED_AT,
    platformUserId: 'user-1', username: 'alice', rawChainId: '999999',
    tokenAddress: EVM, thesis: 'multichain thesis', marketCap: 123,
  });
  return {
    profile, profileEnvelope: createProfileObservationEnvelope(profile, { capturedAt: CAPTURED_AT }),
    calloutEnvelope: createCalloutEnvelope(callout, { capturedAt: CAPTURED_AT }),
  };
}

function fakeDatabase(options = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === __private.CALLOUT_UPSERT) {
        const count = JSON.parse(params[0]).length;
        return { rowCount: options.calloutRowCount ?? count, rows: [] };
      }
      if (sql === __private.CHECKPOINT_UPSERT) {
        return { rowCount: options.checkpointRowCount ?? 1, rows: [] };
      }
      if (options.failOn && sql.includes(options.failOn)) throw new Error('database failed');
      return { rowCount: 1, rows: [] };
    },
    release() { released = true; },
  };
  return {
    calls, client, database: { getClient: async () => client },
    released: () => released,
  };
}

describe('callout capture repository', () => {
  it('commits profiles, multichain wallet evidence, callouts and checkpoint atomically', async () => {
    const data = fixture();
    const fake = fakeDatabase();
    const repository = createCalloutCaptureRepository({ database: fake.database });
    const result = await repository.commitCapture({
      profileEnvelopes: [data.profileEnvelope], calloutEnvelopes: [data.calloutEnvelope],
      checkpointKey: 'pump:live', checkpointState: { marker: 'event-1' }, committedAt: CAPTURED_AT,
    });

    assert.deepEqual(result, { profiles: 1, wallets: 1, callouts: 1, committedAt: CAPTURED_AT });
    assert.deepEqual(fake.calls.map(({ sql }) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return sql;
      if (sql === __private.PROFILE_UPSERT) return 'profiles';
      if (sql === __private.WALLET_UPSERT) return 'wallets';
      if (sql === __private.CALLOUT_UPSERT) return 'callouts';
      return 'checkpoint';
    }), ['BEGIN', 'profiles', 'wallets', 'callouts', 'checkpoint', 'COMMIT']);
    const wallet = JSON.parse(fake.calls[2].params[0])[0];
    assert.deepEqual([wallet.rawChainId, wallet.chainKey, wallet.resolutionStatus],
      ['999999', null, 'unsupported_chain']);
    const event = JSON.parse(fake.calls[3].params[0])[0];
    assert.equal(event.expiresAt, '2026-08-28T12:00:00.000Z');
    assert.equal(JSON.parse(fake.calls[4].params[1]).marker, 'event-1');
    assert.equal(fake.released(), true);
  });

  it('rolls back and does not advance checkpoint when an idempotency conflict is detected', async () => {
    const data = fixture();
    const fake = fakeDatabase({ calloutRowCount: 0 });
    const repository = createCalloutCaptureRepository({ database: fake.database });

    await assert.rejects(repository.commitCapture({
      profileEnvelopes: [data.profileEnvelope], calloutEnvelopes: [data.calloutEnvelope],
      checkpointKey: 'pump:live', checkpointState: { marker: 'event-1' }, committedAt: CAPTURED_AT,
    }), /conflicts with persisted event/);
    assert.equal(fake.calls.some(({ sql }) => sql.includes('callout_collector_checkpoints')), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(fake.released(), true);
  });

  it('rolls back the whole batch rather than overwrite a newer checkpoint', async () => {
    const data = fixture();
    const fake = fakeDatabase({ checkpointRowCount: 0 });
    const repository = createCalloutCaptureRepository({ database: fake.database });

    await assert.rejects(repository.commitCapture({
      profileEnvelopes: [data.profileEnvelope], calloutEnvelopes: [data.calloutEnvelope],
      checkpointKey: 'pump:live', checkpointState: { marker: 'stale' }, committedAt: CAPTURED_AT,
    }), /checkpoint is newer/);
    assert.match(__private.CHECKPOINT_UPSERT, /EXCLUDED\.last_committed_at >=/);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });

  it('deduplicates exact batch replay and rejects conflicting duplicates before opening a transaction', async () => {
    const data = fixture();
    const duplicate = { ...data.calloutEnvelope, capturedAt: '2026-08-25T12:01:00.000Z' };
    const fake = fakeDatabase();
    const repository = createCalloutCaptureRepository({ database: fake.database });
    const result = await repository.commitCapture({
      calloutEnvelopes: [data.calloutEnvelope, duplicate], checkpointKey: 'pump:live',
      checkpointState: {}, committedAt: CAPTURED_AT,
    });
    assert.equal(result.callouts, 1);

    const conflict = { ...duplicate, payload: { ...duplicate.payload, thesis: 'changed' } };
    let opened = false;
    const unopened = createCalloutCaptureRepository({
      database: { getClient: async () => { opened = true; return fake.client; } },
    });
    await assert.rejects(unopened.commitCapture({
      calloutEnvelopes: [data.calloutEnvelope, conflict], checkpointKey: 'pump:live',
      checkpointState: {}, committedAt: CAPTURED_AT,
    }), /conflicting duplicate/);
    assert.equal(opened, false);
  });

  it('uses stable wallet evidence keys across repeated observations', () => {
    const { profile } = fixture();
    const first = walletObservationKey(profile, profile.wallets[0]);
    assert.equal(first, walletObservationKey({ ...profile, observedAt: '2026-08-26T00:00:00Z' }, profile.wallets[0]));
    assert.notEqual(first, walletObservationKey(profile, { ...profile.wallets[0], sourceRecordId: 'trade-2' }));
  });
});
