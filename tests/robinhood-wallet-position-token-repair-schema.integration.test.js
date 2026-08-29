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
    `DELETE FROM robinhood_wallet_token_positions
      WHERE projection_version IN ($1, $2)`, [SHADOW, TARGET]
  );
  await db.query(
    `DELETE FROM robinhood_wallet_position_token_coverage
      WHERE projection_version = $1`, [TARGET]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = $1', [TARGET]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1', [SOURCE]
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

    const committed = await repository.commitShadowRange({
      tokenAddress: TOKEN_ONE, owner: 'integration-owner', fromBlock: '100', toBlock: '149',
      positions: [{
        tokenAddress: TOKEN_ONE, walletAddress: TOKEN_TWO,
        quantityRaw: '10', costBasisUsd: '5', buyVolumeUsd: '5',
        buyMcapWeightedSum: '500', buyMcapWeightUsd: '5', buyTxCount: 1,
        throughBlock: '120', throughLogIndex: '0',
      }],
    });
    assert.equal(committed.complete, false);
    assert.equal(committed.task.nextBlock, '150');
    assert.equal(committed.task.status, 'pending');
    const stored = await db.query(
      `SELECT quantity_raw::text, cost_basis_usd::text, through_block::text
         FROM robinhood_wallet_token_positions
        WHERE projection_version = $1 AND token_address = $2`,
      [SHADOW, TOKEN_ONE]
    );
    assert.deepEqual(stored.rows, [{
      quantity_raw: '10', cost_basis_usd: '5', through_block: '120',
    }]);

    const batch = await repository.claimBatch({
      owner: 'batch-owner', maxBlocks: 50, limit: 10,
    });
    assert.deepEqual(batch.map(({ tokenAddress, nextBlock }) => [tokenAddress, nextBlock]), [
      [TOKEN_TWO, '120'], [TOKEN_ONE, '150'],
    ]);
    const advanced = await repository.commitShadowBatch({
      owner: 'batch-owner', tasks: batch, toBlock: '169', positions: [],
    });
    assert.deepEqual(advanced, { tokens: 2, positions: 0, complete: 0, pending: 2 });
    const frontiers = await db.query(
      `SELECT DISTINCT next_block::text
         FROM robinhood_wallet_position_token_coverage
        WHERE projection_version = $1`, [TARGET]
    );
    assert.deepEqual(frontiers.rows, [{ next_block: '170' }]);

    await db.query(
      `UPDATE robinhood_wallet_position_token_coverage SET
         source_through_block = 169, source_through_hash = $2,
         status = 'complete', completed_at = NOW()
       WHERE projection_version = $1`, [TARGET, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         projection_version, stream, origin_block, next_block, next_block_time,
         safe_head, checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ($1, 'live', 100, 170, NOW(), 169, 169, $2, 'running')`,
      [SOURCE, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_position_cursors (
         projection_version, stream, origin_block, next_block, safe_head,
         checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ($1, 'live', 100, 170, 169, 169, $2, 'running')`,
      [TARGET, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_token_positions (
         projection_version, token_address, wallet_address, quantity_raw,
         through_block, through_log_index
       ) VALUES ($1, $2, $3, 1, 100, 0)`, [TARGET, TOKEN_ONE, TOKEN_TWO]
    );
    assert.equal((await repository.promotionPlan()).readyToPromote, true);
    const prepared = await repository.preparePromotion();
    assert.equal(prepared.extended, 0);
    assert.deepEqual(await repository.promoteNext({ frontier: prepared.frontier }), {
      tokenAddress: TOKEN_ONE, removed: 1, promoted: 1,
    });
    const promoted = await db.query(
      `SELECT quantity_raw::text FROM robinhood_wallet_token_positions
        WHERE projection_version = $1 AND token_address = $2`, [TARGET, TOKEN_ONE]
    );
    assert.deepEqual(promoted.rows, [{ quantity_raw: '10' }]);
  });
});
