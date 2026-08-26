'use strict';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createCalloutCaptureRepository } = require('../src/models/callout-capture');
const { commonCalloutFromPump, createCalloutEnvelope } = require('../src/services/callout-domain');
const {
  createProfileObservation, createProfileObservationEnvelope,
} = require('../src/services/profile-wallet-domain');
const stage161 = require('../src/utils/db-init-stage161');
const stage162 = require('../src/utils/db-init-stage162');
const {
  repairPumpSolanaCalloutChains,
} = require('../src/utils/repair-pump-callout-solana-chains');

const CAPTURED_AT = '2026-08-25T12:00:00.000Z';
const ADDRESS = '0xabcdef0123456789abcdef0123456789abcdef01';
const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';

after(() => db.pool.end());

function envelope() {
  return createCalloutEnvelope(commonCalloutFromPump({
    eventKind: 'callout', sourceEventId: 'archive-integration',
    sourceCreatedAt: CAPTURED_AT, platformUserId: 'profile-integration',
    username: 'integration', rawChainId: '999999', tokenAddress: ADDRESS,
    thesis: 'permanent thesis integration', marketCap: 123,
  }), { capturedAt: CAPTURED_AT });
}

describe('callout permanent archive persistence', () => {
  it('commits archive, accepts an identity replay and rejects an identity collision', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('SET search_path TO pg_temp');
      for (const sql of [...stage161.STATEMENTS, ...stage162.STATEMENTS]) {
        await client.query(sql);
      }
      const repository = createCalloutCaptureRepository({
        database: {
          getClient: async () => ({ query: client.query.bind(client), release() {} }),
        },
      });
      const initial = envelope();
      await repository.commitCapture({
        calloutEnvelopes: [initial], checkpointKey: 'integration:callouts',
        checkpointState: { sequence: 1 }, committedAt: CAPTURED_AT,
      });

      const committed = await client.query(`SELECT
        (SELECT COUNT(*)::int FROM callout_events) AS raw_count,
        (SELECT COUNT(*)::int FROM callout_thesis_archive) AS archive_count,
        (SELECT thesis_sha256 FROM callout_thesis_archive LIMIT 1) AS thesis_sha256`);
      assert.deepEqual(committed.rows[0], {
        raw_count: 1, archive_count: 1,
        thesis_sha256: 'cb6fc40e02020ffbfdf575dd9bb74a79e36c6555036e27d635cbcc3f0f9dbc9d',
      });

      await client.query(
        `UPDATE callout_thesis_archive
            SET source_metadata = '{"archiveOnly":true}'::jsonb`
      );
      const enriched = {
        ...initial,
        payload: {
          ...initial.payload,
          thesis: 'edited replay thesis must not replace the first observation',
          sourceMetadata: { ...initial.payload.sourceMetadata, added: 'value' },
        },
      };
      await repository.commitCapture({
        calloutEnvelopes: [enriched], checkpointKey: 'integration:callouts',
        checkpointState: { sequence: 2 }, committedAt: CAPTURED_AT,
      });

      const replayed = await client.query(`SELECT
        (SELECT thesis FROM callout_events LIMIT 1) AS raw_thesis,
        (SELECT thesis FROM callout_thesis_archive LIMIT 1) AS archive_thesis,
        (SELECT source_metadata FROM callout_thesis_archive LIMIT 1) AS archive_metadata,
        (SELECT state FROM callout_collector_checkpoints LIMIT 1) AS checkpoint_state`);
      assert.deepEqual(replayed.rows[0], {
        raw_thesis: initial.payload.thesis,
        archive_thesis: initial.payload.thesis,
        archive_metadata: { archiveOnly: true },
        checkpoint_state: { sequence: 2 },
      });

      for (const table of ['callout_events', 'callout_thesis_archive']) {
        await client.query(`UPDATE ${table} SET
          asset_address_original = $1, asset_address_normalized = NULL,
          asset_raw_chain_id = NULL, asset_chain_key = NULL, asset_chain_family = NULL,
          asset_resolution_status = 'unknown_chain'`, [SOLANA]);
      }
      const repairDatabase = {
        query: client.query.bind(client),
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const repaired = await repairPumpSolanaCalloutChains(repairDatabase, { mode: 'write' });
      assert.deepEqual(repaired.repaired, { archive: 1, live: 1 });
      const repairedRows = await client.query(`SELECT asset_chain_key, asset_address_normalized,
        asset_resolution_status FROM callout_thesis_archive`);
      assert.deepEqual(repairedRows.rows[0], {
        asset_chain_key: 'solana', asset_address_normalized: SOLANA,
        asset_resolution_status: 'inferred_solana_address',
      });

      const enrichedAt = '2026-08-25T12:05:00.000Z';
      const profile = createProfileObservation({
        platform: 'pump', platformUserId: 'profile-integration', username: 'enriched-user',
        xUsername: 'enriched-x', profilePictureUrl: 'https://example.test/avatar.png',
        observedAt: enrichedAt, source: 'user_profile_backfill',
        wallets: [{
          address: SOLANA, rawChainId: 'solana', relationType: 'profile_wallet',
          sourceType: 'platform_reported', sourceField: 'address', confidence: 'high',
        }],
      });
      await repository.commitCapture({
        profileEnvelopes: [createProfileObservationEnvelope(profile)], calloutEnvelopes: [],
        checkpointKey: 'pump:profile-enrichment', checkpointState: { version: 1 },
        committedAt: enrichedAt,
      });
      const enrichedProfile = await client.query(`SELECT p.username, p.profile_picture_url,
        w.address_normalized FROM callout_profiles p
        JOIN callout_wallet_observations w USING (platform, platform_user_id)`);
      assert.deepEqual(enrichedProfile.rows[0], {
        username: 'enriched-user', profile_picture_url: 'https://example.test/avatar.png',
        address_normalized: SOLANA,
      });

      const collision = {
        ...initial,
        payload: { ...initial.payload, platformEventId: 'different-event-id' },
      };
      await assert.rejects(repository.commitCapture({
        calloutEnvelopes: [collision], checkpointKey: 'integration:callouts',
        checkpointState: { sequence: 3 }, committedAt: CAPTURED_AT,
      }), /Callout replay conflicts with persisted event/);
      const checkpoint = await client.query(
        'SELECT state FROM callout_collector_checkpoints LIMIT 1'
      );
      assert.deepEqual(checkpoint.rows[0].state, { sequence: 2 });
    } finally {
      client.release();
    }
  });
});
