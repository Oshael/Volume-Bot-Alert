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
      if (sql === __private.ARCHIVE_UPSERT) {
        const count = JSON.parse(params[0]).length;
        return { rowCount: options.archiveRowCount ?? count, rows: [] };
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
  it('commits profiles, wallets, raw and archived callouts, and checkpoint atomically', async () => {
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
      if (sql === __private.ARCHIVE_UPSERT) return 'archive';
      return 'checkpoint';
    }), ['BEGIN', 'profiles', 'wallets', 'callouts', 'archive', 'checkpoint', 'COMMIT']);
    const wallet = JSON.parse(fake.calls[2].params[0])[0];
    assert.deepEqual([wallet.rawChainId, wallet.chainKey, wallet.resolutionStatus],
      ['999999', null, 'unsupported_chain']);
    const event = JSON.parse(fake.calls[3].params[0])[0];
    assert.equal(event.expiresAt, '2026-08-28T12:00:00.000Z');
    assert.equal(event.thesisSha256, '4f8ad2bfea9bdd0ba71d9bcbb20992830365d9e6c4abaddaad8ce96233d9f06d');
    assert.equal(JSON.parse(fake.calls[5].params[1]).marker, 'event-1');
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

  it('keeps first-write data for the same platform event during database replay', () => {
    assert.match(__private.CALLOUT_UPSERT,
      /WHEN callout_events\.source_metadata <@ EXCLUDED\.source_metadata/);
    assert.match(__private.CALLOUT_UPSERT,
      /THEN callout_events\.source_metadata \|\| EXCLUDED\.source_metadata/);
    assert.match(__private.CALLOUT_UPSERT,
      /ELSE callout_events\.source_metadata/);
    assert.match(__private.CALLOUT_UPSERT,
      /callout_events\.platform_event_id IS NOT DISTINCT FROM EXCLUDED\.platform_event_id/);
    assert.doesNotMatch(__private.CALLOUT_UPSERT,
      /callout_events\.thesis IS NOT DISTINCT FROM EXCLUDED\.thesis/);
    assert.match(__private.ARCHIVE_UPSERT,
      /WHEN archived\.source_metadata <@ EXCLUDED\.source_metadata/);
    assert.match(__private.ARCHIVE_UPSERT,
      /archived\.platform_event_id IS NOT DISTINCT FROM EXCLUDED\.platform_event_id/);
    assert.doesNotMatch(__private.ARCHIVE_UPSERT,
      /archived\.thesis_sha256 IS NOT DISTINCT FROM EXCLUDED\.thesis_sha256/);
    assert.doesNotMatch(__private.ARCHIVE_UPSERT, /expires_at|ON DELETE CASCADE/);
  });

  it('rolls back raw persistence when permanent archival conflicts', async () => {
    const data = fixture();
    const fake = fakeDatabase({ archiveRowCount: 0 });
    const repository = createCalloutCaptureRepository({ database: fake.database });

    await assert.rejects(repository.commitCapture({
      calloutEnvelopes: [data.calloutEnvelope], checkpointKey: 'pump:live',
      checkpointState: { marker: 'event-1' }, committedAt: CAPTURED_AT,
    }), /archive replay conflicts/);
    assert.equal(fake.calls.some(({ sql }) => sql === __private.CHECKPOINT_UPSERT), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
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

  it('prunes only expired callout rows through a bounded non-blocking query', async () => {
    const calls = [];
    const repository = createCalloutCaptureRepository({
      database: { query: async (sql, params) => {
        calls.push({ sql, params });
        return { rowCount: 50, rows: [] };
      } },
    });

    assert.deepEqual(await repository.pruneExpiredCallouts({ batchLimit: 50 }), {
      deletedCallouts: 50, hasMore: true,
    });
    assert.equal(calls[0].sql, __private.PRUNE_EXPIRED_CALLOUTS);
    assert.deepEqual(calls[0].params, [50]);
    assert.match(calls[0].sql, /expires_at <= NOW\(\)/);
    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.doesNotMatch(calls[0].sql,
      /callout_profiles|callout_wallet_observations|callout_thesis_archive/);
    await assert.rejects(
      repository.pruneExpiredCallouts({ batchLimit: 10_001 }),
      /batchLimit must be between 1 and 10000/
    );
  });
});
