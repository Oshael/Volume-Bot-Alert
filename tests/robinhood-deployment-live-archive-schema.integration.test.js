'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { createRobinhoodTokenDeploymentOutboxRepository } = require(
  '../src/models/robinhood-token-deployment-outbox'
);
const stage165 = require('../src/utils/db-init-stage165');
const stage215 = require('../src/utils/db-init-stage215');
const stage242 = require('../src/utils/db-init-stage242');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const EXPIRED = `0x${'7'.repeat(40)}`;
const LIVE = `0x${'8'.repeat(40)}`;

describe('Stage 242 deployment live/Archive lanes', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
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
        ('robinhood', $2, NOW(), NOW()+INTERVAL '72 hours')
      ON CONFLICT (chain, token_address) DO UPDATE SET
        status='pending', attempt_count=0, next_attempt_at=NOW(),
        lease_owner=NULL, lease_until=NULL, last_error=NULL,
        created_at=EXCLUDED.created_at, live_deadline_at=EXCLUDED.live_deadline_at,
        archive_required_at=NULL`, [EXPIRED, LIVE]);

      const repository = createRobinhoodTokenDeploymentOutboxRepository({ database: client });
      assert.equal(await repository.archiveExpiredBatch({ limit: 10 }), 1);
      const claimed = await repository.claimBatch({ owner: 'stage242-test', limit: 10 });
      assert.deepEqual(claimed.map(({ tokenAddress }) => tokenAddress), [LIVE]);

      const expired = (await client.query(`SELECT status,
          archive_required_at IS NOT NULL AS archived
        FROM robinhood_token_deployment_outbox WHERE token_address=$1`, [EXPIRED])).rows[0];
      assert.deepEqual(expired, { status: 'archive_required', archived: true });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
