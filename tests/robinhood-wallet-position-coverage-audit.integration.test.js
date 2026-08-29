process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletPositionCoverageAuditor,
} = require('../src/models/robinhood-wallet-position-coverage-audit');
const stage116 = require('../src/utils/db-init-stage116');
const stage126 = require('../src/utils/db-init-stage126');
const stage129 = require('../src/utils/db-init-stage129');
const stage134 = require('../src/utils/db-init-stage134');
const stage137 = require('../src/utils/db-init-stage137');
const stage154 = require('../src/utils/db-init-stage154');
const stage158 = require('../src/utils/db-init-stage158');
const stage159 = require('../src/utils/db-init-stage159');
const stage170 = require('../src/utils/db-init-stage170');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TRANSFER_VERSION = 'position_coverage_transfer_it';
const POSITION_VERSION = 'position_coverage_position_it';
const TOKEN = `0x${'e'.repeat(40)}`;
const HASH = `0x${'f'.repeat(64)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_position_token_coverage WHERE projection_version = $1',
    [POSITION_VERSION]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_token_coverage WHERE projection_version = $1',
    [TRANSFER_VERSION]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = $1',
    [POSITION_VERSION]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1',
    [TRANSFER_VERSION]
  );
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
}

async function seedFrontiers() {
  await db.query(
    `INSERT INTO robinhood_wallet_transfer_cursors (
       projection_version, stream, origin_block, next_block, next_block_time, safe_head,
       checkpoint_block, checkpoint_hash, lifecycle_state, completed_at, created_at
     ) VALUES
       ($1, 'seed', 100, 200, '2026-08-24T00:00:00Z', 199, 199, $2,
        'complete', '2026-08-24T01:00:00Z', '2026-08-24T00:00:00Z'),
       ($1, 'live', 200, 300, '2026-08-24T02:00:00Z', 299, 299, $2,
        'running', NULL, '2026-08-24T01:00:00Z')`,
    [TRANSFER_VERSION, HASH]
  );
  await db.query(
    `INSERT INTO robinhood_wallet_position_cursors (
       projection_version, stream, origin_block, next_block, safe_head,
       checkpoint_block, checkpoint_hash, lifecycle_state, completed_at, created_at
     ) VALUES
       ($1, 'seed', 100, 200, 199, 199, $2,
        'complete', '2026-08-24T01:00:00Z', '2026-08-24T00:00:00Z'),
       ($1, 'live', 200, 300, 299, 299, $2,
        'running', NULL, '2026-08-24T01:00:00Z')`,
    [POSITION_VERSION, HASH]
  );
  await db.query(
    `INSERT INTO robinhood_holder_token_states (
       token_address, ledger_status, created_at
     ) VALUES ($1, 'live', '2026-08-23T23:00:00Z')`,
    [TOKEN]
  );
  await db.query(
    `INSERT INTO robinhood_wallet_transfer_token_coverage (
       projection_version, token_address, source_from_block, next_block,
       source_through_block, source_through_hash, status, attempt_count,
       completed_at, published_at
     ) VALUES ($1, $2, 100, 300, 299, $3, 'complete', 1, NOW(), NOW())`,
    [TRANSFER_VERSION, TOKEN, HASH]
  );
}

describe('Robinhood wallet-position coverage audit', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage116, stage126, stage129, stage134, stage137, stage154, stage158, stage159, stage170,
    ]) await stage.init({ closePool: false });
    await cleanup();
    await seedFrontiers();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('proves coverage when repair publication and financial frontiers agree', async () => {
    const auditor = createRobinhoodWalletPositionCoverageAuditor({
      database: db, transferVersion: TRANSFER_VERSION, positionVersion: POSITION_VERSION,
    });
    const result = await auditor.audit();
    assert.equal(result.ready, true);
    assert.equal(result.repairRequired, false);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.repair.publishedTokens, 1);
  });

  it('fails closed when a repaired token entered after the financial seed began', async () => {
    await db.query(
      `UPDATE robinhood_holder_token_states
          SET created_at = '2026-08-24T00:00:01Z'
        WHERE token_address = $1`,
      [TOKEN]
    );
    const auditor = createRobinhoodWalletPositionCoverageAuditor({
      database: db, transferVersion: TRANSFER_VERSION, positionVersion: POSITION_VERSION,
    });
    const result = await auditor.audit();
    assert.equal(result.ready, false);
    assert.equal(result.repairRequired, true);
    assert.deepEqual(result.reasons, ['position_token_repair_required']);
  });

  it('accepts a late token after its financial shadow is published', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_position_token_coverage (
         projection_version, shadow_projection_version, source_transfer_version,
         token_address, source_from_block, next_block, source_through_block,
         source_through_hash, status, completed_at, published_at
       ) VALUES ($1, 'position_coverage_shadow_it', $2, $3, 100, 300, 299,
         $4, 'complete', NOW(), NOW())`,
      [POSITION_VERSION, TRANSFER_VERSION, TOKEN, HASH]
    );
    const auditor = createRobinhoodWalletPositionCoverageAuditor({
      database: db, transferVersion: TRANSFER_VERSION, positionVersion: POSITION_VERSION,
    });
    const result = await auditor.audit();
    assert.equal(result.ready, true);
    assert.equal(result.repair.positionRepairedTokens, 1);
    assert.deepEqual(result.reasons, []);
  });
});
