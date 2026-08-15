process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodTokenTransferRepository,
} = require('../src/models/robinhood-token-transfer-persistence');
const {
  createRobinhoodWalletTransferReclassificationRepository,
} = require('../src/models/robinhood-wallet-transfer-reclassification');
const {
  persistTransferProjection,
} = require('../src/models/robinhood-wallet-transfer-projection');
const stage128 = require('../src/utils/db-init-stage128');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const stage132 = require('../src/utils/db-init-stage132');
const stage135 = require('../src/utils/db-init-stage135');
const stage136 = require('../src/utils/db-init-stage136');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_reclassification_v1';
const TRANSITION_VERSION = 'test_transition_v1';
const DAY = '2099-10-01';
const BLOCK_TIME = `${DAY}T00:00:00.000Z`;
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const TX1 = `0x${'9'.repeat(64)}`;
const TX2 = `0x${'8'.repeat(64)}`;
const BLOCK_HASH = `0x${'7'.repeat(64)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_reclassifications WHERE to_classification_version = $1',
    [VERSION]
  );
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [VERSION]);
  await db.query(
    'DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = ANY($1::varchar[])',
    [[ALICE, BOB]]
  );
  await db.query(
    `DELETE FROM robinhood_token_transfer_events
     WHERE chain = 'robinhood' AND transaction_hash = ANY($1::varchar[])`,
    [[TX1, TX2]]
  );
}

async function insertUnknown(transactionHash, logIndex, amountRaw) {
  const repository = createRobinhoodTokenTransferRepository({ database: db });
  await repository.insertTransferEvents([{
    blockNumber: '100', blockHash: BLOCK_HASH, blockTime: BLOCK_TIME,
    transactionHash, transactionIndex: String(logIndex), logIndex: String(logIndex),
    tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB, amountRaw,
    transferKind: 'unknown', classificationVersion: VERSION,
  }]);
}

function transition(transactionHash, logIndex) {
  return {
    transactionHash, logIndex, blockTime: BLOCK_TIME,
    fromClassificationVersion: VERSION, toTransferKind: 'wallet_transfer',
    toClassificationVersion: VERSION, transitionVersion: TRANSITION_VERSION,
    decisionReason: 'known_wallet_pair',
    decisionEvidence: { fromRole: 'wallet', toRole: 'wallet', resolverVersion: 'test_role_v1' },
  };
}

async function insertVerifiedWatermark() {
  await db.query(
    `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
       chain, projection_version, partition_day, lifecycle_state,
       raw_event_count, target_classified_event_count, eligible_transfer_count,
       eligible_amount_raw, summary_transfer_count, summary_amount_raw,
       raw_last_block, raw_last_transaction_index, raw_last_log_index,
       cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
       cursor_next_block_time, checkpoint_block, checkpoint_hash,
       position_projection_version, position_next_block, summary_reconciled,
       position_complete, evidence_complete, cursor_complete, checkpoint_canonical,
       audited_at, verified_at
     ) VALUES ('robinhood', $1, $2::date, 'verified', 1, 1, 0, 0, 0, 0,
       100, 1, 1, 101, 0, 0, '2099-10-02T00:00:00.000Z', 100, $3,
       'test_unified_position_v1', 101, true, true, true, true, true, NOW(), NOW())`,
    [VERSION, DAY, BLOCK_HASH]
  );
}

async function insertRole(endpoint, evidenceBlock) {
  await db.query(
    `INSERT INTO robinhood_wallet_endpoint_roles (
       chain, endpoint_address, endpoint_role, evidence_source, evidence_block,
       evidence_block_hash, resolver_version, observed_from_block, observed_through_block
     ) VALUES ('robinhood', $1, 'wallet', 'pc_archive', $2, $3,
       'test_role_v1', $2, $2)`,
    [endpoint, evidenceBlock, BLOCK_HASH]
  );
}

describe('Robinhood wallet transfer reclassification persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage128, stage129, stage130, stage131, stage132, stage135, stage136]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('applies once, invalidates stale proof and rolls every effect back on failure', async () => {
    await insertUnknown(TX1, 1, '25');
    await insertRole(ALICE, 100);
    await insertRole(BOB, 101);
    const repository = createRobinhoodWalletTransferReclassificationRepository({ database: db });
    const selection = { classificationVersion: VERSION, day: DAY, limit: 10 };
    assert.equal((await repository.listCandidates(selection)).length, 0);
    await db.query(
      `UPDATE robinhood_wallet_endpoint_roles SET evidence_block = 100,
         observed_from_block = 100, observed_through_block = 100
       WHERE endpoint_address = $1`,
      [BOB]
    );
    const [candidate] = await repository.listCandidates(selection);
    assert.equal(candidate.transactionHash, TX1);
    assert.equal(candidate.fromRoleEvidence.observedFromBlock, '100');
    await insertVerifiedWatermark();
    const applied = await repository.applyTransition(transition(TX1, 1));
    assert.deepEqual(applied, {
      applied: true,
      projected: { edgeGroups: 1, dailySummaryGroups: 1, evidenceCandidates: 3 },
      watermarksInvalidated: 1,
    });
    assert.deepEqual(await repository.applyTransition(transition(TX1, 1)), {
      applied: false, reason: 'already_applied',
    });

    const raw = await db.query(
      `SELECT transfer_kind, classification_version FROM robinhood_token_transfer_events
       WHERE transaction_hash = $1`, [TX1]
    );
    assert.deepEqual(raw.rows[0], {
      transfer_kind: 'wallet_transfer', classification_version: VERSION,
    });
    const counts = await db.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM robinhood_wallet_transfer_reclassifications
           WHERE transaction_hash = $1) AS audits,
         (SELECT transfer_count::integer FROM robinhood_wallet_transfer_edges
           WHERE classification_version = $2) AS edges,
         (SELECT transfer_count::integer FROM robinhood_wallet_transfer_daily_summaries
           WHERE projection_version = $2) AS daily,
         (SELECT COUNT(*)::integer FROM robinhood_wallet_relationship_evidence
           WHERE algorithm_version = $2) AS evidence`,
      [TX1, VERSION]
    );
    assert.deepEqual(counts.rows[0], { audits: 1, edges: 1, daily: 1, evidence: 3 });
    const watermark = await db.query(
      `SELECT lifecycle_state, state_reason, summary_reconciled, position_complete,
              evidence_complete, verified_at
       FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1`,
      [VERSION]
    );
    assert.deepEqual(watermark.rows[0], {
      lifecycle_state: 'blocked', state_reason: 'reclassification_applied',
      summary_reconciled: false, position_complete: false,
      evidence_complete: false, verified_at: null,
    });

    await insertUnknown(TX2, 2, '50');
    const failing = createRobinhoodWalletTransferReclassificationRepository({
      database: db,
      persistProjection: async (...args) => {
        await persistTransferProjection(...args);
        throw new Error('projection failed');
      },
    });
    await assert.rejects(failing.applyTransition(transition(TX2, 2)), /projection failed/);
    const rolledBack = await db.query(
      `SELECT transfer_kind, (SELECT COUNT(*)::integer
         FROM robinhood_wallet_transfer_reclassifications WHERE transaction_hash = $1) AS audits
       FROM robinhood_token_transfer_events WHERE transaction_hash = $1`,
      [TX2]
    );
    assert.deepEqual(rolledBack.rows[0], { transfer_kind: 'unknown', audits: 0 });
    const projectedAfterRollback = await db.query(
      `SELECT
         (SELECT transfer_count::integer FROM robinhood_wallet_transfer_edges
           WHERE classification_version = $1) AS edges,
         (SELECT transfer_count::integer FROM robinhood_wallet_transfer_daily_summaries
           WHERE projection_version = $1) AS daily,
         (SELECT COUNT(*)::integer FROM robinhood_wallet_relationship_evidence
           WHERE algorithm_version = $1) AS evidence`,
      [VERSION]
    );
    assert.deepEqual(projectedAfterRollback.rows[0], { edges: 1, daily: 1, evidence: 3 });
  });
});
