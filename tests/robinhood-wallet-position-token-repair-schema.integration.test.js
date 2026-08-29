process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletPositionTokenRepairRepository,
} = require('../src/models/robinhood-wallet-position-token-repair');
const stage170 = require('../src/utils/db-init-stage170');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TARGET = 'unified_position_repair_it';
const SHADOW = 'unified_position_shadow_it';
const SOURCE = 'rh_transfer_repair_it';
const TOKEN_ONE = `0x${'1'.repeat(40)}`;
const TOKEN_TWO = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query(
    `DELETE FROM robinhood_wallet_position_token_coverage
      WHERE projection_version = $1`, [TARGET]
  );
}

describe('Robinhood wallet-position token repair coverage', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage170.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('enforces resumable leases and exposes durable progress', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_position_token_coverage (
         projection_version, shadow_projection_version, source_transfer_version,
         token_address, source_from_block, next_block,
         source_through_block, source_through_hash
       ) VALUES
         ($1, $2, $3, $4, 100, 100, 200, $6),
         ($1, $2, $3, $5, 120, 120, 200, $6)`,
      [TARGET, SHADOW, SOURCE, TOKEN_ONE, TOKEN_TWO, HASH]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_wallet_position_token_coverage SET status = 'leased'
          WHERE projection_version = $1 AND token_address = $2`,
        [TARGET, TOKEN_ONE]
      ),
      /rh_wallet_position_token_coverage_lease_check/
    );
    await db.query(
      `UPDATE robinhood_wallet_position_token_coverage SET
         status = 'leased', lease_owner = 'expired',
         lease_until = NOW() - INTERVAL '1 second'
       WHERE projection_version = $1 AND token_address = $2`,
      [TARGET, TOKEN_ONE]
    );
    const repository = createRobinhoodWalletPositionTokenRepairRepository({
      database: db, targetVersion: TARGET, shadowVersion: SHADOW, sourceVersion: SOURCE,
    });
    assert.deepEqual(await repository.recover(), { staleLeases: 1, failed: 0 });
    const claimed = await repository.claim({ owner: 'integration-owner' });
    assert.equal(claimed.tokenAddress, TOKEN_ONE);
    assert.equal(claimed.nextBlock, '100');
    assert.equal(claimed.status, 'leased');
    const plan = await repository.plan();
    assert.equal(plan.candidates, 2);
    assert.equal(plan.leased, 1);
    assert.equal(plan.pending, 1);
    assert.equal(plan.remaining_block_span, '182');
  });
});
