'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const {
  createRobinhoodBundleRedistributionLiveSource,
} = require('../src/models/robinhood-bundle-redistribution-live-source');
const stage241 = require('../src/utils/db-init-stage241');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'f'.repeat(40)}`;
const CREATOR = `0x${'e'.repeat(40)}`;
const OBSERVATION_BLOCK = 99_124_500;
const FRONTIER_BLOCK = 99_124_501;
const OBSERVATION_HASH = `0x${'8'.repeat(64)}`;
const FRONTIER_HASH = `0x${'9'.repeat(64)}`;
const OBSERVATION_TIME = '2098-09-20T12:00:00.000Z';
const FRONTIER_TIME = '2098-09-20T12:10:00.000Z';

describe('Robinhood BUNDLED redistribution durable-anchor source', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage241.init({ closePool: false });
  });
  after(async () => { await db.pool.end(); });

  it('loads a frozen empty snapshot after its raw blocks were removed', async () => {
    const client = await db.getClient();
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM robinhood_chain_blocks
        WHERE chain='robinhood' AND block_number IN ($1, $2)`,
      [OBSERVATION_BLOCK, FRONTIER_BLOCK]);
      await client.query(`INSERT INTO robinhood_chain_block_anchors(
        chain, block_number, block_hash, block_timestamp
      ) VALUES ('robinhood', $1, $2, $3), ('robinhood', $4, $5, $6)
      ON CONFLICT (chain, block_number, block_hash) DO UPDATE
        SET block_timestamp=EXCLUDED.block_timestamp`,
      [OBSERVATION_BLOCK, OBSERVATION_HASH, OBSERVATION_TIME,
        FRONTIER_BLOCK, FRONTIER_HASH, FRONTIER_TIME]);
      await client.query(`INSERT INTO robinhood_holder_token_states(
        chain, token_address, holder_count, ledger_status,
        live_through_block, live_through_hash
      ) VALUES ('robinhood', $1, 0, 'live', $2, $3)
      ON CONFLICT (chain, token_address) DO UPDATE SET
        ledger_status='live', live_through_block=EXCLUDED.live_through_block,
        live_through_hash=EXCLUDED.live_through_hash`, [TOKEN, FRONTIER_BLOCK, FRONTIER_HASH]);
      await client.query(`INSERT INTO robinhood_token_attributions(
        chain, token_address, creator_address, source, last_resolved_at
      ) VALUES ('robinhood', $1, $2, 'blockscout', NOW())
      ON CONFLICT (chain, token_address) DO UPDATE SET
        creator_address=EXCLUDED.creator_address, source='blockscout',
        attribution_block=NULL, attribution_tx_hash=NULL,
        attribution_factory_address=NULL, last_resolved_at=NOW()`, [TOKEN, CREATOR]);
      const seed = (await client.query(`INSERT INTO robinhood_first_buy_backfill_runs(
        chain, source_from, source_through, range_seconds, status, started_at, finished_at
      ) VALUES ('robinhood', $1::timestamptz - INTERVAL '1 day', $1, 3600,
        'completed', NOW(), NOW()) RETURNING id`, [FRONTIER_TIME])).rows[0];
      await client.query(`INSERT INTO robinhood_first_buy_live_cursors(
        chain, seed_run_id, next_time, source_through, source_next_block
      ) VALUES ('robinhood', $1, $2, $2, $3)
      ON CONFLICT (chain) DO UPDATE SET seed_run_id=EXCLUDED.seed_run_id,
        next_time=EXCLUDED.next_time, source_through=EXCLUDED.source_through,
        source_next_block=EXCLUDED.source_next_block`,
      [seed.id, FRONTIER_TIME, FRONTIER_BLOCK + 1]);
      await client.query(`INSERT INTO robinhood_wallet_swap_cursors(
        chain, stream, next_block, safe_head, lifecycle_state
      ) VALUES ('robinhood', 'live', $1, $2, 'running')
      ON CONFLICT (chain, stream) DO UPDATE SET next_block=EXCLUDED.next_block,
        safe_head=EXCLUDED.safe_head, lifecycle_state='running',
        completed_at=NULL, abandoned_at=NULL`, [FRONTIER_BLOCK + 1, FRONTIER_BLOCK]);
      await client.query(`INSERT INTO robinhood_wallet_transfer_cursors(
        chain, projection_version, stream, next_block, next_block_time,
        safe_head, lifecycle_state
      ) VALUES ('robinhood', 'rh_transfer_v1', 'live', $1, $2, $3, 'running')
      ON CONFLICT (chain, projection_version, stream) DO UPDATE SET
        next_block=EXCLUDED.next_block, next_block_time=EXCLUDED.next_block_time,
        safe_head=EXCLUDED.safe_head, lifecycle_state='running',
        completed_at=NULL, failed_at=NULL`,
      [FRONTIER_BLOCK + 1, FRONTIER_TIME, FRONTIER_BLOCK]);

      const source = createRobinhoodBundleRedistributionLiveSource({
        database: { query: client.query.bind(client) },
      });
      const result = await source.loadToken(TOKEN, {
        observationFromBlock: String(OBSERVATION_BLOCK),
        eventThroughBlock: String(FRONTIER_BLOCK),
        observationFromHash: OBSERVATION_HASH, observationFromTime: OBSERVATION_TIME,
        sourceThroughBlock: String(FRONTIER_BLOCK), sourceThroughHash: FRONTIER_HASH,
        sourceThroughTime: FRONTIER_TIME, requestedVersion: '7', sourceRequestedVersion: '7',
      });
      assert.equal(result.ready, true);
      assert.deepEqual(result.frontier, {
        blockNumber: String(FRONTIER_BLOCK), blockHash: FRONTIER_HASH,
      });
      assert.deepEqual(result.sources, []);
      assert.equal((await client.query(`SELECT COUNT(*)::integer AS count
        FROM robinhood_chain_blocks WHERE chain='robinhood'
          AND block_number IN ($1, $2)`,
      [OBSERVATION_BLOCK, FRONTIER_BLOCK])).rows[0].count, 0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
