process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } = require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferCompactionAuditor } = require('../src/models/robinhood-wallet-transfer-compaction');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const stage128 = require('../src/utils/db-init-stage128');
const stage129 = require('../src/utils/db-init-stage129');
const stage131 = require('../src/utils/db-init-stage131');
const stage132 = require('../src/utils/db-init-stage132');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_compaction_audit_v1';
const POSITION_VERSION = 'test_unified_transfer_v1';
const DAY = '2099-01-03';
const PARTITION = 'robinhood_token_transfer_events_2099_01_03';
const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;

function event(logIndex, transferKind, amountRaw) {
  return {
    blockNumber: '100', blockHash: HASH, blockTime: `${DAY}T12:00:00.000Z`,
    transactionHash: `0x${String(logIndex).padStart(64, 'b')}`,
    transactionIndex: String(logIndex), logIndex: String(logIndex), tokenAddress: TOKEN,
    fromWallet: `0x${'2'.repeat(40)}`, toWallet: `0x${'3'.repeat(40)}`,
    amountRaw: String(amountRaw), transferKind, classificationVersion: VERSION,
  };
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = $1', [POSITION_VERSION]);
  await db.query(
    `DELETE FROM robinhood_token_transfer_events
     WHERE block_time >= $1::date AND block_time < $1::date + INTERVAL '1 day'`,
    [DAY]
  );
}

describe('Robinhood wallet transfer compaction audit', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage126, stage127, stage128, stage129, stage131, stage132]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.query(`DROP TABLE IF EXISTS ${PARTITION}`);
    await db.pool.end();
  });

  it('records blocked until the transfer-adjusted position frontier exists', async () => {
    const raw = createRobinhoodTokenTransferRepository({ database: db });
    await raw.insertTransferEvents([
      event(1, 'wallet_transfer', 10),
      event(2, 'mint', 20),
    ]);
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_daily_summaries (
         chain, projection_version, summary_day, token_address,
         transfer_count, total_amount_raw, wallet_transfer_count,
         wallet_transfer_amount_raw, dex_flow_count, dex_flow_amount_raw,
         through_block, through_transaction_index, through_log_index, through_block_time
       ) VALUES ('robinhood', $1, $2, $3, 1, 10, 1, 10, 0, 0, 100, 1, 1, $4)`,
      [VERSION, DAY, TOKEN, `${DAY}T12:00:00.000Z`]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         chain, projection_version, stream, next_block, next_block_time,
         checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ('robinhood', $1, 'live', 101, $2, 100, $3, 'running')`,
      [VERSION, '2099-01-04T00:00:00.000Z', HASH]
    );
    const auditor = createRobinhoodWalletTransferCompactionAuditor({
      database: db, loadCanonicalBlockHash: async () => HASH,
    });
    const blocked = await auditor.auditDay({
      projectionVersion: VERSION, positionProjectionVersion: POSITION_VERSION, partitionDay: DAY,
    });
    assert.equal(blocked.watermark.lifecycle_state, 'blocked');
    assert.match(blocked.watermark.state_reason, /position_incomplete/);
    assert.equal(blocked.audit.summaryMismatchCount, 0);
    assert.equal(blocked.audit.targetClassifiedEventCount, '2');

    await db.query(
      `INSERT INTO robinhood_wallet_position_cursors (
         chain, projection_version, stream, next_block, lifecycle_state
       ) VALUES ('robinhood', $1, 'live', 101, 'running')`,
      [POSITION_VERSION]
    );
    const verified = await auditor.auditDay({
      projectionVersion: VERSION, positionProjectionVersion: POSITION_VERSION, partitionDay: DAY,
    });
    assert.equal(verified.watermark.lifecycle_state, 'verified');
    assert.equal(verified.watermark.state_reason, null);
    assert.equal(verified.watermark.version, '1');
    assert.equal(verified.audit.eligibleTransferCount, '1');
    assert.equal(verified.audit.summaryTransferCount, '1');
  });

  it('rejects the swap-only position as compaction evidence', async () => {
    const auditor = createRobinhoodWalletTransferCompactionAuditor({
      database: db, loadCanonicalBlockHash: async () => HASH,
    });
    await assert.rejects(
      auditor.auditDay({
        projectionVersion: VERSION, positionProjectionVersion: 'swap_only_v1', partitionDay: DAY,
      }),
      /cannot prove transfer-adjusted positions/
    );
  });
});
