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
const stage153 = require('../src/utils/db-init-stage153');
const stage191 = require('../src/utils/db-init-stage191');
const stage205 = require('../src/utils/db-init-stage205');
const stage243 = require('../src/utils/db-init-stage243');
const stage244 = require('../src/utils/db-init-stage244');
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
const TX3 = `0x${'6'.repeat(64)}`;
const BLOCK_HASH = `0x${'7'.repeat(64)}`;
const RAWLESS_VERSION = 'test_rawless_reclassification_v1';
const RAWLESS_DAY = '2099-10-03';
const RAWLESS_TIME = `${RAWLESS_DAY}T00:00:00.000Z`;
const RAWLESS_HASH = `0x${'4'.repeat(64)}`;
const RAWLESS_TX = `0x${'5'.repeat(64)}`;
const RAWLESS_TOKEN = `0x${'a'.repeat(40)}`;
const RAWLESS_FROM = `0x${'b'.repeat(40)}`;
const RAWLESS_TO = `0x${'c'.repeat(40)}`;
let insertedCaptureCursor = false;
let originalCaptureCursor = null;

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1', [RAWLESS_TX]);
  await db.query('DELETE FROM robinhood_wallet_transfer_reclassifications WHERE to_classification_version = $1', [RAWLESS_VERSION]);
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = $1', [RAWLESS_VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1', [RAWLESS_VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1', [RAWLESS_VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [RAWLESS_VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE transaction_hash = $1', [RAWLESS_TX]);
  await db.query('DELETE FROM robinhood_token_transfer_events WHERE transaction_hash = $1', [RAWLESS_TX]);
  await db.query('DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = ANY($1::varchar[])', [[RAWLESS_FROM, RAWLESS_TO]]);
  await db.query('DELETE FROM robinhood_chain_blocks WHERE block_hash = $1', [RAWLESS_HASH]);
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = ANY($1::varchar[])',
    [[TX1, TX2, TX3]]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_reclassifications WHERE to_classification_version = $1',
    [VERSION]
  );
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE classification_version = $1', [VERSION]);
  await db.query(
    'DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = ANY($1::varchar[])',
    [[ALICE, BOB]]
  );
  await db.query(
    `DELETE FROM robinhood_token_transfer_events
     WHERE chain = 'robinhood' AND transaction_hash = ANY($1::varchar[])`,
    [[TX1, TX2, TX3]]
  );
}

async function insertUnknown(transactionHash, logIndex, amountRaw, preservePendingEvidence = false) {
  const repository = createRobinhoodTokenTransferRepository({ database: db, preservePendingEvidence });
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

async function insertRawlessCanonicalBlock() {
  await db.query(
    `INSERT INTO robinhood_chain_blocks (
       chain, block_number, block_hash, parent_hash, capture_digest,
       block_timestamp, head_observed_at, receipts_available_at
     ) VALUES ('robinhood', 200, $1, $2, $3, $4::timestamptz, NOW(), NOW())`,
    [RAWLESS_HASH, `0x${'e'.repeat(64)}`, `0x${'f'.repeat(64)}`, RAWLESS_TIME]
  );
}

describe('Robinhood wallet transfer reclassification persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage128, stage129, stage130, stage131, stage132, stage135, stage136, stage153,
      stage191, stage205, stage243, stage244,
    ]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });

  after(async () => {
    await cleanup();
    if (insertedCaptureCursor) {
      await db.query("DELETE FROM robinhood_chain_capture_cursor WHERE chain = 'robinhood'");
    } else if (originalCaptureCursor) {
      await db.query(
        `UPDATE robinhood_chain_capture_cursor SET recovery_state = $1,
           recovery_plan = $2::jsonb, recovery_detected_at = $3
         WHERE chain = 'robinhood'`,
        [originalCaptureCursor.recovery_state, originalCaptureCursor.recovery_plan,
          originalCaptureCursor.recovery_detected_at]
      );
    }
    await db.pool.end();
  });

  it('applies once, invalidates stale proof and rolls every effect back on failure', async () => {
    await insertUnknown(TX1, 1, '25', true);
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
    const marker = await db.query(
      `SELECT disposition, block_hash FROM robinhood_wallet_transfer_evidence_dispositions
       WHERE transaction_hash = $1`, [TX1]
    );
    assert.deepEqual(marker.rows, [{ disposition: 'reclassified', block_hash: BLOCK_HASH }]);
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
    const directional = await db.query(
      `SELECT first_wallet_transfer_block::text AS block_number,
              first_wallet_transfer_log_index AS log_index,
              first_wallet_transfer_transaction_hash AS transaction_hash,
              first_wallet_transfer_amount_raw::text AS amount_raw
         FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`,
      [VERSION]
    );
    assert.deepEqual(directional.rows[0], {
      block_number: '100', log_index: 1, transaction_hash: TX1, amount_raw: '25',
    });
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

    await insertUnknown(TX2, 2, '50', true);
    const failing = createRobinhoodWalletTransferReclassificationRepository({
      database: db,
      persistProjection: async (...args) => {
        const competitor = await db.getClient();
        try {
          await competitor.query('BEGIN');
          const lock = await competitor.query(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
            [`rh-transfer-retention-day:${DAY}`]
          );
          assert.equal(lock.rows[0].acquired, false);
        } finally {
          await competitor.query('ROLLBACK').catch(() => {});
          competitor.release();
        }
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
    const rolledBackMarker = await db.query(
      'SELECT 1 FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1',
      [TX2]
    );
    assert.equal(rolledBackMarker.rowCount, 0);
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

  it('rejects a preserved orphan but still supports legacy raw-only events', async () => {
    await insertUnknown(TX3, 3, '75', true);
    const repository = createRobinhoodWalletTransferReclassificationRepository({ database: db });
    const selection = { classificationVersion: VERSION, day: DAY, limit: 10 };
    await db.query(
      'UPDATE robinhood_wallet_transfer_pending_evidence SET amount_raw = 76 WHERE transaction_hash = $1',
      [TX3]
    );
    assert.equal((await repository.listCandidates(selection)).find((item) => (
      item.transactionHash === TX3
    )).amountRaw, '76');
    await assert.rejects(repository.applyTransition(transition(TX3, 3)),
      /preserved transfer evidence conflicts/);
    await db.query(
      'UPDATE robinhood_wallet_transfer_pending_evidence SET amount_raw = 75 WHERE transaction_hash = $1',
      [TX3]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_evidence_dispositions (
         chain, transaction_hash, log_index, block_time, disposition, block_hash
       ) VALUES ('robinhood', $1, 3, $2::timestamptz, 'orphaned', $3)`,
      [TX3, BLOCK_TIME, BLOCK_HASH]
    );
    assert.equal((await repository.listCandidates(selection)).some((item) => (
      item.transactionHash === TX3
    )), false);
    await assert.rejects(repository.applyTransition(transition(TX3, 3)),
      /preserved transfer evidence conflicts/);
    const raw = await db.query(
      'SELECT transfer_kind FROM robinhood_token_transfer_events WHERE transaction_hash = $1', [TX3]
    );
    assert.equal(raw.rows[0].transfer_kind, 'unknown');
    const markers = await db.query(
      `SELECT disposition FROM robinhood_wallet_transfer_evidence_dispositions
       WHERE transaction_hash = $1`, [TX3]
    );
    assert.deepEqual(markers.rows, [{ disposition: 'orphaned' }]);
    await db.query(
      'DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1', [TX3]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_evidence_dispositions (
         chain, transaction_hash, log_index, block_time, disposition, block_hash
       ) VALUES ('robinhood', $1, 3, $2::timestamptz, 'reclassified', $3)`,
      [TX3, BLOCK_TIME, BLOCK_HASH]
    );
    assert.equal((await repository.listCandidates(selection)).some((item) => (
      item.transactionHash === TX3
    )), false);
    await db.query(
      'DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1', [TX3]
    );
    await db.query(
      'DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE transaction_hash = $1', [TX3]
    );
    assert.equal((await repository.listCandidates(selection)).some((item) => (
      item.transactionHash === TX3
    )), true);
    assert.equal((await repository.applyTransition(transition(TX3, 3))).applied, true);
    const legacyMarkers = await db.query(
      'SELECT 1 FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1',
      [TX3]
    );
    assert.equal(legacyMarkers.rowCount, 0);
  });

  it('reclassifies preserved evidence without raw under canonical and dropped-day fences', async () => {
    const previous = await db.query(
      `SELECT recovery_state, recovery_plan, recovery_detected_at
       FROM robinhood_chain_capture_cursor WHERE chain = 'robinhood'`
    );
    originalCaptureCursor = previous.rows[0] || null;
    const cursor = await db.query(
      `INSERT INTO robinhood_chain_capture_cursor(chain, next_block, recovery_state)
       VALUES ('robinhood', 1, 'running') ON CONFLICT (chain) DO NOTHING
       RETURNING chain`
    );
    insertedCaptureCursor = cursor.rowCount === 1;
    if (originalCaptureCursor) {
      await db.query(
        `UPDATE robinhood_chain_capture_cursor SET recovery_state = 'running',
           recovery_plan = NULL, recovery_detected_at = NULL WHERE chain = 'robinhood'`
      );
    }
    await insertRawlessCanonicalBlock();
    for (const endpoint of [RAWLESS_FROM, RAWLESS_TO]) {
      await db.query(
        `INSERT INTO robinhood_wallet_endpoint_roles (
           chain, endpoint_address, endpoint_role, evidence_source, evidence_block,
           evidence_block_hash, resolver_version, observed_from_block, observed_through_block
         ) VALUES ('robinhood', $1, 'wallet', 'pc_archive', 200, $2,
           'test_role_v1', 200, 200)`, [endpoint, RAWLESS_HASH]
      );
    }
    await createRobinhoodTokenTransferRepository({
      database: db, preservePendingEvidence: true,
    }).insertTransferEvents([{
      blockNumber: '200', blockHash: RAWLESS_HASH, blockTime: RAWLESS_TIME,
      transactionHash: RAWLESS_TX, transactionIndex: '1', logIndex: '1',
      tokenAddress: RAWLESS_TOKEN, fromWallet: RAWLESS_FROM, toWallet: RAWLESS_TO,
      amountRaw: '35', transferKind: 'unknown', classificationVersion: RAWLESS_VERSION,
    }]);
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE transaction_hash = $1', [RAWLESS_TX]);
    const repository = createRobinhoodWalletTransferReclassificationRepository({ database: db });
    const selection = { classificationVersion: RAWLESS_VERSION, day: RAWLESS_DAY, limit: 10 };
    assert.equal((await repository.listCandidates(selection))[0].transactionHash, RAWLESS_TX);
    const action = {
      ...transition(RAWLESS_TX, 1), blockTime: RAWLESS_TIME,
      fromClassificationVersion: RAWLESS_VERSION,
      toClassificationVersion: RAWLESS_VERSION,
    };
    assert.deepEqual(await repository.applyTransition({
      ...action, fromClassificationVersion: VERSION,
    }), { applied: false, reason: 'classification_conflict' });
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_evidence_dispositions (
         chain, transaction_hash, log_index, block_time, disposition, block_hash
       ) VALUES ('robinhood', $1, 1, $2::timestamptz, 'orphaned', $3)`,
      [RAWLESS_TX, RAWLESS_TIME, RAWLESS_HASH]
    );
    try {
      await assert.rejects(repository.applyTransition(action), /evidence is orphaned/);
    } finally {
      await db.query(
        'DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1',
        [RAWLESS_TX]
      );
    }
    await db.query(
      `UPDATE robinhood_chain_capture_cursor SET recovery_state = 'recovery_required',
         recovery_plan = '{}'::jsonb, recovery_detected_at = NOW()
       WHERE chain = 'robinhood'`
    );
    try {
      await assert.rejects(repository.applyTransition(action), /fenced by canonical recovery/);
    } finally {
      await db.query(
        `UPDATE robinhood_chain_capture_cursor SET recovery_state = 'running',
           recovery_plan = NULL, recovery_detected_at = NULL WHERE chain = 'robinhood'`
      );
    }
    await db.query('UPDATE robinhood_chain_blocks SET canonical = false WHERE block_hash = $1', [RAWLESS_HASH]);
    await assert.rejects(repository.applyTransition(action), /not canonical/);
    await db.query('UPDATE robinhood_chain_blocks SET canonical = true WHERE block_hash = $1', [RAWLESS_HASH]);
    await db.query('DELETE FROM robinhood_chain_blocks WHERE block_hash = $1', [RAWLESS_HASH]);
    try {
      await assert.rejects(repository.applyTransition(action),
        (error) => error.code === 'archive_required');
    } finally {
      await insertRawlessCanonicalBlock();
    }
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
         audited_at, verified_at, dropped_at
       ) VALUES ('robinhood', $1, $2::date, 'dropped',
         1, 1, 0, 0, 0, 0, 200, 1, 1,
         201, 0, 0, '2099-10-04T00:00:00Z', 200, $3,
         'test_position_v1', 201, true, true, true, true, true,
         NOW(), NOW(), NOW())`, [RAWLESS_VERSION, RAWLESS_DAY, RAWLESS_HASH]
    );
    const failing = createRobinhoodWalletTransferReclassificationRepository({
      database: db, persistProjection: async (...args) => {
        await persistTransferProjection(...args);
        throw new Error('rawless projection failed');
      },
    });
    await assert.rejects(failing.applyTransition(action), /rawless projection failed/);
    assert.equal((await db.query(
      'SELECT 1 FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1',
      [RAWLESS_TX]
    )).rowCount, 0);
    const applied = await repository.applyTransition(action);
    assert.equal(applied.applied, true);
    assert.equal(applied.watermarksInvalidated, 0);
    assert.deepEqual(await repository.applyTransition(action), {
      applied: false, reason: 'already_applied',
    });
    assert.equal((await repository.listCandidates(selection)).length, 0);
    assert.equal((await db.query(
      'SELECT 1 FROM robinhood_token_transfer_events WHERE transaction_hash = $1', [RAWLESS_TX]
    )).rowCount, 0);
    assert.equal((await db.query(
      `SELECT lifecycle_state FROM robinhood_wallet_transfer_compaction_watermarks
       WHERE projection_version = $1`, [RAWLESS_VERSION]
    )).rows[0].lifecycle_state, 'dropped');
  });
});
