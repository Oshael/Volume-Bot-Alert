'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { runPilot } = require('../src/services/robinhood-chain-event-pruner');

it('keeps young or referenced partitions and drops only an expired unreferenced one',
  async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    const database = { getClient: async () => ({
      query: (...args) => client.query(...args), release() {},
    }) };
    const deps = { database,
      audit: { inspect: async () => ({ chain_events: {
        ready_for_pilot: false, journal_start_block: '1',
        candidate_cutoff_block: '250000',
        blockers: [{ code: 'wallet_classification_archive_required' }],
      } }) },
      resolveRetentionCutoff: async () => '250000',
    };
    try {
      await client.query(`CREATE TEMP TABLE robinhood_chain_events (
        chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
        log_index integer NOT NULL,
        PRIMARY KEY (chain, block_number, block_hash, log_index)
      ) PARTITION BY RANGE (block_number)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_events_shadow_b0
        PARTITION OF robinhood_chain_events FOR VALUES FROM (0) TO (250000)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_events_shadow_b250000
        PARTITION OF robinhood_chain_events FOR VALUES FROM (250000) TO (500000)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain text, block_number bigint, block_timestamp timestamptz)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
        chain text, finalized_head bigint, recovery_state text)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_domain_outbox (
        chain text, block_number bigint, block_hash text, log_index integer,
        FOREIGN KEY (chain, block_number, block_hash, log_index)
          REFERENCES robinhood_chain_events ON DELETE CASCADE)`);
      await client.query(`CREATE TEMP TABLE robinhood_canonical_head_candidates (
        chain text, block_number bigint, block_hash text, log_index integer,
        FOREIGN KEY (chain, block_number, block_hash, log_index)
          REFERENCES robinhood_chain_events ON DELETE CASCADE)`);
      await client.query(`CREATE TEMP TABLE robinhood_token_deployment_outbox (
        chain text, mint_block_number bigint)`);
      await client.query(`CREATE TEMP TABLE robinhood_bundle_redistribution_queue (
        chain text, status text, observation_from_hash text,
        observation_from_block bigint)`);
      await client.query(`INSERT INTO robinhood_chain_events VALUES
        ('robinhood', 100, 'old', 1), ('robinhood', 250100, 'new', 1)`);
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES
        ('robinhood', 100, NOW() - INTERVAL '2 days')`);
      await client.query(`INSERT INTO robinhood_chain_capture_cursor VALUES
        ('robinhood', 500000, 'running')`);
      await client.query(`INSERT INTO robinhood_chain_domain_outbox VALUES
        ('robinhood', 100, 'old', 1)`);

      const options = { partitionDropEnabled: true };
      const otherBlocker = await runPilot(options, { ...deps,
        audit: { inspect: async () => ({ chain_events: {
          ready_for_pilot: false, blockers: [
            { code: 'wallet_classification_archive_required' },
            { code: 'consumer_checkpoint_invalid' },
          ],
        } }) },
      });
      assert.equal(otherBlocker.reason, 'retention_safety_audit');
      let result = await runPilot(options, deps);
      assert.equal(result.stopReason, 'blocked');
      await client.query(`UPDATE robinhood_chain_blocks
        SET block_timestamp=NOW() - INTERVAL '4 days' WHERE block_number=100`);
      result = await runPilot(options, deps);
      assert.equal(result.stopReason, 'blocked');
      await client.query('DELETE FROM robinhood_chain_domain_outbox');
      await client.query(`INSERT INTO robinhood_token_deployment_outbox
        VALUES ('robinhood', 100)`);
      assert.equal((await runPilot(options, deps)).stopReason, 'blocked');
      await client.query('DELETE FROM robinhood_token_deployment_outbox');
      await client.query(`INSERT INTO robinhood_bundle_redistribution_queue
        VALUES ('robinhood', 'pending', NULL, 100)`);
      assert.equal((await runPilot(options, deps)).stopReason, 'blocked');
      await client.query('DELETE FROM robinhood_bundle_redistribution_queue');
      await client.query(`INSERT INTO robinhood_token_deployment_outbox
        VALUES ('robinhood', 300000)`);
      await client.query(`INSERT INTO robinhood_bundle_redistribution_queue
        VALUES ('robinhood', 'pending', NULL, 300000)`);
      const boundary = await runPilot({ partitionPreview: true }, {
        ...deps, resolveRetentionCutoff: async () => '249999',
      });
      assert.equal(boundary.stopReason, 'prefix_drained');
      const preview = await runPilot({ partitionPreview: true }, deps);
      assert.equal(preview.stopReason, 'eligible');
      assert.deepEqual(preview.deferredBlockers,
        [{ code: 'wallet_classification_archive_required' }]);
      assert.equal(preview.droppedPartitions, 0);
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM robinhood_chain_events`)).rows[0].n, 2);
      result = await runPilot(options, deps);
      assert.equal(result.droppedPartitions, 1);
      assert.equal(result.stopReason, 'partition_limit');
      assert.equal((await client.query(`SELECT to_regclass(
        'pg_temp.robinhood_chain_events_shadow_b0') AS partition`)).rows[0].partition,
      null);
      assert.deepEqual((await client.query(`SELECT block_number::text
        FROM robinhood_chain_events`)).rows.map((row) => row.block_number), ['250100']);
      const fks = await client.query(`SELECT count(*)::int AS n FROM pg_constraint
        WHERE contype='f' AND confrelid=to_regclass('robinhood_chain_events')
          AND convalidated`);
      assert.equal(fks.rows[0].n, 2);
    } finally {
      for (const name of ['robinhood_chain_domain_outbox',
        'robinhood_canonical_head_candidates', 'robinhood_token_deployment_outbox',
        'robinhood_bundle_redistribution_queue', 'robinhood_chain_events',
        'robinhood_chain_blocks', 'robinhood_chain_capture_cursor']) {
        await client.query(`DROP TABLE IF EXISTS pg_temp.${name} CASCADE`);
      }
      client.release();
      await db.pool.end();
    }
  });
