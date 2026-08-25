process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletTransferTokenRepairRepository,
} = require('../src/models/robinhood-wallet-transfer-token-repair');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const stage134 = require('../src/utils/db-init-stage134');
const stage153 = require('../src/utils/db-init-stage153');
const stage154 = require('../src/utils/db-init-stage154');
const stage158 = require('../src/utils/db-init-stage158');
const stage159 = require('../src/utils/db-init-stage159');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'8'.repeat(40)}`;
const TOKEN_TWO = `0x${'4'.repeat(40)}`;
const TOKEN_THREE = `0x${'5'.repeat(40)}`;
const TEST_TOKENS = [TOKEN, TOKEN_TWO, TOKEN_THREE];
const FROM = `0x${'6'.repeat(40)}`;
const TO = `0x${'7'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TARGET_TEST_VERSION = 'rh_transfer_token_repair_it';
const SHADOW_TEST_VERSION = 'rh_transfer_token_repair_shadow_it';

function event(block, suffix) {
  return {
    tokenAddress: TOKEN, fromWallet: FROM, toWallet: TO,
    blockNumber: String(block), transactionIndex: 0, logIndex: 1,
    blockTime: `2026-08-24T00:0${suffix}:00.000Z`,
    transactionHash: `0x${String(suffix).repeat(64)}`,
    amountRaw: '10', transferKind: 'wallet_transfer',
    classificationVersion: 'rh_transfer_v1',
  };
}

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = ANY($1) AND token_address = ANY($2)',
    [[SHADOW_TEST_VERSION, TARGET_TEST_VERSION], TEST_TOKENS]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = ANY($1) AND token_address = ANY($2)',
    [[SHADOW_TEST_VERSION, TARGET_TEST_VERSION], TEST_TOKENS]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = ANY($1) AND token_address = ANY($2)',
    [[SHADOW_TEST_VERSION, TARGET_TEST_VERSION], TEST_TOKENS]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_token_coverage WHERE projection_version = $1 AND token_address = ANY($2)',
    [TARGET_TEST_VERSION, TEST_TOKENS]
  );
  await db.query(
    "DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1 AND stream IN ('seed', 'live')",
    [TARGET_TEST_VERSION]
  );
}

describe('Robinhood wallet-transfer token repair persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage129, stage130, stage131, stage134, stage153, stage154, stage158, stage159,
    ]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('resumes ranges into shadow and completes only after the frozen frontier', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         projection_version, stream, origin_block, next_block, next_block_time,
         safe_head, checkpoint_block, checkpoint_hash, lifecycle_state, completed_at
       ) VALUES
         ($1, 'seed', 100, 102, '2026-08-24T00:02:00Z', 101, 101, $2, 'complete', NOW()),
         ($1, 'live', 102, 102, '2026-08-24T00:02:00Z', 101, 101, $2, 'running', NULL)`,
      [TARGET_TEST_VERSION, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_token_coverage (
         projection_version, token_address, source_from_block, next_block,
         source_through_block, source_through_hash
       ) VALUES ($1, $2, 100, 100, 101, $3)`,
      [TARGET_TEST_VERSION, TOKEN, HASH]
    );
    const repository = createRobinhoodWalletTransferTokenRepairRepository({
      targetVersion: TARGET_TEST_VERSION, shadowVersion: SHADOW_TEST_VERSION,
    });
    await db.query(
      `UPDATE robinhood_wallet_transfer_token_coverage SET
         status = 'leased', lease_owner = 'dead-process', lease_until = NOW() - INTERVAL '1 second'
       WHERE projection_version = $1 AND token_address = $2`,
      [TARGET_TEST_VERSION, TOKEN]
    );
    assert.deepEqual(await repository.recover(), { staleLeases: 1, failed: 0 });
    const first = await repository.claim({ owner: 'integration-owner' });
    assert.equal(first.nextBlock, '100');
    const projected = await repository.commitShadowRange({
      tokenAddress: TOKEN, owner: 'integration-owner',
      fromBlock: '100', toBlock: '100', events: [event(100, 1)],
    });
    assert.equal(projected.complete, false);
    const second = await repository.claim({ owner: 'integration-owner' });
    assert.equal(second.nextBlock, '101');
    const completed = await repository.commitShadowRange({
      tokenAddress: TOKEN, owner: 'integration-owner',
      fromBlock: '101', toBlock: '101', events: [event(101, 2)],
    });
    assert.equal(completed.complete, true);
    const result = await db.query(
      `SELECT edge.transfer_count::text, edge.first_block::text, edge.last_block::text,
              coverage.status, coverage.next_block::text
         FROM robinhood_wallet_transfer_edges edge
         JOIN robinhood_wallet_transfer_token_coverage coverage
           ON coverage.token_address = edge.token_address
        WHERE edge.classification_version = $1 AND edge.token_address = $2`,
      [SHADOW_TEST_VERSION, TOKEN]
    );
    assert.deepEqual(result.rows[0], {
      transfer_count: '2', first_block: '100', last_block: '101',
      status: 'complete', next_block: '102',
    });
    const promotion = await repository.promoteNext();
    assert.equal(promotion.status, 'published');
    const published = await db.query(
      `SELECT edge.transfer_count::text, coverage.published_at IS NOT NULL AS published,
              (SELECT COUNT(*)::integer FROM robinhood_wallet_transfer_edges shadow
                WHERE shadow.classification_version = $3
                  AND shadow.token_address = $2) AS shadow_count
         FROM robinhood_wallet_transfer_edges edge
         JOIN robinhood_wallet_transfer_token_coverage coverage
           ON coverage.projection_version = $1 AND coverage.token_address = edge.token_address
        WHERE edge.classification_version = $1 AND edge.token_address = $2`,
      [TARGET_TEST_VERSION, TOKEN, SHADOW_TEST_VERSION]
    );
    assert.deepEqual(published.rows[0], {
      transfer_count: '2', published: true, shadow_count: 0,
    });
  });

  it('claims and advances multiple token cursors with one shared window', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_token_coverage (
         projection_version, token_address, source_from_block, next_block,
         source_through_block, source_through_hash
       ) VALUES ($1, $2, 100, 100, 199, $4), ($1, $3, 120, 120, 199, $4)`,
      [TARGET_TEST_VERSION, TOKEN_TWO, TOKEN_THREE, HASH]
    );
    const repository = createRobinhoodWalletTransferTokenRepairRepository({
      targetVersion: TARGET_TEST_VERSION, shadowVersion: SHADOW_TEST_VERSION,
    });
    const claimed = await repository.claimBatch({
      owner: 'batch-integration-owner', maxBlocks: 50, limit: 10,
    });
    assert.deepEqual(claimed.map(({ tokenAddress, nextBlock }) => (
      [tokenAddress, nextBlock]
    )), [[TOKEN_TWO, '100'], [TOKEN_THREE, '120']]);

    const committed = await repository.commitShadowBatch({
      owner: 'batch-integration-owner', tasks: claimed, toBlock: '149', events: [],
    });
    assert.deepEqual({ tokens: committed.tokens, complete: committed.complete,
      pending: committed.pending }, { tokens: 2, complete: 0, pending: 2 });
    const cursors = await db.query(
      `SELECT token_address, next_block::text, status
         FROM robinhood_wallet_transfer_token_coverage
        WHERE projection_version = $1 AND token_address = ANY($2)
        ORDER BY token_address`,
      [TARGET_TEST_VERSION, [TOKEN_TWO, TOKEN_THREE]]
    );
    assert.deepEqual(cursors.rows, [
      { token_address: TOKEN_TWO, next_block: '150', status: 'pending' },
      { token_address: TOKEN_THREE, next_block: '150', status: 'pending' },
    ]);
    const plan = await repository.plan();
    assert.deepEqual([plan.earliest_pending_block, plan.latest_pending_block], ['150', '199']);
  });
});
