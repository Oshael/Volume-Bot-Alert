'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { createRobinhoodTokenDeploymentOutboxRepository } = require(
  '../src/models/robinhood-token-deployment-outbox'
);
const stage165 = require('../src/utils/db-init-stage165');
const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage183 = require('../src/utils/db-init-stage183');
const stage215 = require('../src/utils/db-init-stage215');
const stage242 = require('../src/utils/db-init-stage242');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const EXPIRED = `0x${'7'.repeat(40)}`;
const LIVE = `0x${'8'.repeat(40)}`;
const FRESH = `0x${'9'.repeat(40)}`;
const EXACT = `0x${'6'.repeat(40)}`;
const UNRESOLVED = `0x${'5'.repeat(40)}`;

describe('Stage 242 deployment live/Archive lanes', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage110.init({ closePool: false });
    const { rows: [columns] } = await db.query(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name =
        'robinhood_token_attributions' AND column_name = 'attribution_block') AS has_block,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name =
        'robinhood_token_attributions' AND column_name = 'attribution_factory_address') AS has_factory`);
    if (!columns.has_block) await stage113.init({ closePool: false });
    if (!columns.has_factory) await stage114.init({ closePool: false });
    await stage183.init({ closePool: false });
    await stage165.init({ closePool: false });
    await stage215.init({ closePool: false });
    await stage242.init({ closePool: false });
    await stage242.init({ closePool: false });
  });
  after(async () => { await db.pool.end(); });

  it('archives expired work and leases only the live lane', async () => {
    const client = await db.getClient();
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO robinhood_token_deployment_outbox(
        chain, token_address, created_at, live_deadline_at
      ) VALUES
        ('robinhood', $1, NOW()-INTERVAL '80 hours', NOW()-INTERVAL '8 hours'),
        ('robinhood', $2, NOW()-INTERVAL '1 hour', NOW()+INTERVAL '1 hour'),
        ('robinhood', $3, NOW(), NOW()+INTERVAL '72 hours')
      ON CONFLICT (chain, token_address) DO UPDATE SET
        status='pending', attempt_count=0, next_attempt_at=NOW(),
        lease_owner=NULL, lease_until=NULL, last_error=NULL,
        created_at=EXCLUDED.created_at, live_deadline_at=EXCLUDED.live_deadline_at,
        archive_required_at=NULL`, [EXPIRED, LIVE, FRESH]);
      await client.query(`UPDATE robinhood_token_deployment_outbox
        SET mint_block_number=100, mint_block_hash=$2, mint_transaction_hash=$3
        WHERE chain='robinhood' AND token_address=$1`,
      [FRESH, `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`]);

      const repository = createRobinhoodTokenDeploymentOutboxRepository({ database: client });
      assert.equal(await repository.archiveExpiredBatch({ limit: 10 }), 1);
      const claimed = await repository.claimBatch({ owner: 'stage242-test', limit: 1 });
      assert.deepEqual(claimed.map(({ tokenAddress }) => tokenAddress), [FRESH]);
      assert.deepEqual((await repository.claimBatch({ owner: 'stage242-test', limit: 1 }))
        .map(({ tokenAddress }) => tokenAddress), [LIVE]);

      const expired = (await client.query(`SELECT status,
          archive_required_at IS NOT NULL AS archived
        FROM robinhood_token_deployment_outbox WHERE token_address=$1`, [EXPIRED])).rows[0];
      assert.deepEqual(expired, { status: 'archive_required', archived: true });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('removes exact attributions before leasing without hiding unresolved work', async () => {
    const client = await db.getClient();
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO robinhood_token_attributions (
        chain, token_address, source, attribution_block
      ) VALUES ('robinhood', $1, 'rpc_code_transition', 100)
      ON CONFLICT (chain, token_address) DO UPDATE SET
        creator_address=NULL, source='rpc_code_transition', attribution_block=100,
        attribution_tx_hash=NULL, attribution_factory_address=NULL,
        last_resolved_at=NULL`, [EXACT]);
      await client.query(`INSERT INTO robinhood_token_attributions (
        chain, token_address, source
      ) VALUES ('robinhood', $1, 'blockscout')
      ON CONFLICT (chain, token_address) DO UPDATE SET
        creator_address=NULL, source='blockscout', attribution_block=NULL,
        attribution_tx_hash=NULL, attribution_factory_address=NULL,
        last_resolved_at=NULL`, [UNRESOLVED]);
      await client.query(`INSERT INTO robinhood_token_deployment_outbox (
        chain, token_address, created_at, live_deadline_at,
        mint_block_number, mint_block_hash, mint_transaction_hash
      ) VALUES
        ('robinhood', $1, NOW()-INTERVAL '1 second', NOW()+INTERVAL '72 hours',
          100, $3, $4),
        ('robinhood', $2, NOW()-INTERVAL '2 seconds', NOW()+INTERVAL '72 hours',
          101, $3, $4)
      ON CONFLICT (chain, token_address) DO UPDATE SET
        status='pending', attempt_count=0, next_attempt_at=NOW(),
        lease_owner=NULL, lease_until=NULL, last_error=NULL,
        created_at=EXCLUDED.created_at, live_deadline_at=EXCLUDED.live_deadline_at,
        archive_required_at=NULL`,
      [EXACT, UNRESOLVED, `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`]);

      const repository = createRobinhoodTokenDeploymentOutboxRepository({ database: client });
      const claimed = await repository.claimBatchWithStats({ owner: 'stage242-exact', limit: 2 });
      assert.equal(claimed.removedExact, 1);
      assert.deepEqual(claimed.tasks.map(({ tokenAddress }) => tokenAddress), [UNRESOLVED]);
      const { rows } = await client.query(`SELECT token_address, status, attempt_count
        FROM robinhood_token_deployment_outbox
        WHERE chain='robinhood' AND token_address IN ($1, $2)
        ORDER BY token_address`, [EXACT, UNRESOLVED]);
      assert.deepEqual(rows.map(({ token_address, status, attempt_count }) =>
        [token_address, status, attempt_count]), [[UNRESOLVED, 'leased', 1]]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
