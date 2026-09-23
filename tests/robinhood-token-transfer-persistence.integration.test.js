process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage128 = require('../src/utils/db-init-stage128');
const stage132 = require('../src/utils/db-init-stage132');
const stage138 = require('../src/utils/db-init-stage138');
const stage243 = require('../src/utils/db-init-stage243');
const {
  createRobinhoodTokenTransferRepository,
} = require('../src/models/robinhood-token-transfer-persistence');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const RETENTION_VERSION = 'test_writer_retention_v1';
const FIRST_GUARDED_DAY = '2199-01-02';
const DROPPED_GUARDED_DAY = '2199-01-03';

function event(day, suffix, overrides = {}) {
  return {
    blockNumber: String(100 + suffix), blockHash: `0x${'a'.repeat(63)}${suffix}`,
    blockTime: `${day}T${suffix ? '00:00:00' : '23:59:59'}.000Z`,
    transactionHash: `0x${'b'.repeat(63)}${suffix}`,
    transactionIndex: String(suffix), logIndex: String(suffix), tokenAddress: TOKEN,
    fromWallet: `0x${'0'.repeat(40)}`, toWallet: `0x${'2'.repeat(40)}`,
    amountRaw: String(suffix), ...overrides,
  };
}

describe('Robinhood token transfer persistence integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage128.init({ closePool: false });
    await stage132.init({ closePool: false });
    await stage138.init({ closePool: false });
    await stage243.init({ closePool: false });
    await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [RETENTION_VERSION]);
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
    await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE token_address = $1', [TOKEN]);
  });
  after(async () => {
    await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [RETENTION_VERSION]);
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
    await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE token_address = $1', [TOKEN]);
    await db.query('DROP TABLE IF EXISTS robinhood_token_transfer_events_2098_12_31');
    await db.query('DROP TABLE IF EXISTS robinhood_token_transfer_events_2099_01_01');
    await db.query('DROP TABLE IF EXISTS robinhood_token_transfer_events_2199_01_02');
    await db.query('DROP TABLE IF EXISTS robinhood_token_transfer_events_2199_01_03');
    await db.pool.end();
  });

  it('persists and deduplicates evidence across a UTC partition boundary', async () => {
    const repository = createRobinhoodTokenTransferRepository({ database: db });
    const rows = [
      event('2098-12-31', 0),
      event('2099-01-01', 1, {
        fromWallet: `0x${'2'.repeat(40)}`, transferKind: 'wallet_self',
        classificationVersion: 'rh_transfer_v1',
      }),
    ];
    const first = await repository.insertTransferEvents(rows);
    const duplicate = await repository.insertTransferEvents(rows);
    await assert.rejects(db.query(
      `INSERT INTO robinhood_token_transfer_events (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) SELECT chain, block_number, block_hash, block_time + INTERVAL '1 second',
         transaction_hash, transaction_index, log_index, token_address,
         from_wallet, to_wallet, amount_raw, 'mint', NULL
       FROM robinhood_token_transfer_events WHERE token_address = $1 LIMIT 1`,
      [TOKEN]
    ), /rh_token_transfer_events_classification_check/);
    const stored = await db.query(
      `SELECT block_time, amount_raw::text, transfer_kind, classification_version
       FROM robinhood_token_transfer_events WHERE token_address = $1 ORDER BY block_time`,
      [TOKEN]
    );

    assert.deepEqual(first, { inserted: 2, ensuredDays: ['2098-12-31', '2099-01-01'] });
    assert.equal(duplicate.inserted, 0);
    assert.deepEqual(stored.rows.map((row) => row.amount_raw), ['0', '1']);
    assert.deepEqual(stored.rows.map(({ transfer_kind: kind, classification_version: version }) => (
      { kind, version }
    )), [
      { kind: 'unclassified', version: null },
      { kind: 'wallet_self', version: 'rh_transfer_v1' },
    ]);
  });

  it('preserves only new unknown transfers and deduplicates the durable copy', async () => {
    const repository = createRobinhoodTokenTransferRepository({
      database: db, preservePendingEvidence: true,
    });
    const unknown = event('2099-01-01', 2, {
      transferKind: 'unknown', classificationVersion: 'rh_transfer_v1',
    });
    assert.equal((await repository.insertTransferEvents([unknown])).inserted, 1);
    assert.equal((await repository.insertTransferEvents([unknown])).inserted, 0);
    const { rows } = await db.query(
      `SELECT block_number::text, transaction_index, amount_raw::text,
              classification_version, block_time
       FROM robinhood_wallet_transfer_pending_evidence WHERE token_address = $1`,
      [TOKEN]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].block_number, unknown.blockNumber);
    assert.equal(rows[0].transaction_index, Number(unknown.transactionIndex));
    assert.equal(rows[0].amount_raw, unknown.amountRaw);
    assert.equal(rows[0].classification_version, unknown.classificationVersion);
    assert.equal(new Date(rows[0].block_time).toISOString(), unknown.blockTime);
  });

  it('rolls back the raw insert if preserving unknown evidence fails', async () => {
    const repository = createRobinhoodTokenTransferRepository({
      database: db, preservePendingEvidence: true,
    });
    const unknown = event('2099-01-01', 3, {
      transferKind: 'unknown', classificationVersion: 'rh_transfer_v1',
    });
    await db.query(`CREATE OR REPLACE FUNCTION rh_test_pending_evidence_reject()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced pending evidence failure'; END $$`);
    await db.query(`CREATE TRIGGER rh_test_pending_evidence_reject
      BEFORE INSERT ON robinhood_wallet_transfer_pending_evidence
      FOR EACH ROW EXECUTE FUNCTION rh_test_pending_evidence_reject()`);
    try {
      await assert.rejects(repository.insertTransferEvents([unknown]), /forced pending evidence failure/);
      const raw = await db.query(
        'SELECT 1 FROM robinhood_token_transfer_events WHERE transaction_hash = $1',
        [unknown.transactionHash]
      );
      assert.equal(raw.rowCount, 0);
    } finally {
      await db.query('DROP TRIGGER rh_test_pending_evidence_reject ON robinhood_wallet_transfer_pending_evidence');
      await db.query('DROP FUNCTION rh_test_pending_evidence_reject()');
    }
  });

  it('refuses a dropped day and rolls back partitions created earlier in the same batch', async () => {
    const before = await db.query(
      `SELECT to_regclass('robinhood_token_transfer_events_2199_01_02') AS first,
              to_regclass('robinhood_token_transfer_events_2199_01_03') AS dropped`
    );
    assert.deepEqual(before.rows[0], { first: null, dropped: null });
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
         chain, projection_version, partition_day, lifecycle_state,
         raw_event_count, target_classified_event_count, eligible_transfer_count,
         eligible_amount_raw, summary_transfer_count, summary_amount_raw,
         cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
         cursor_next_block_time, checkpoint_block, checkpoint_hash,
         position_projection_version, position_next_block, summary_reconciled,
         position_complete, evidence_complete, cursor_complete, checkpoint_canonical,
         audited_at, verified_at, dropped_at
       ) VALUES ('robinhood', $1, $3::date, 'dropped',
         0, 0, 0, 0, 0, 0, 101, 0, 0, '2200-01-01T00:00:00Z',
         100, $2, 'test_position_v1', 101, true, true, true, true, true,
         NOW(), NOW(), NOW())`,
      [RETENTION_VERSION, `0x${'a'.repeat(64)}`, DROPPED_GUARDED_DAY]
    );
    const repository = createRobinhoodTokenTransferRepository({ database: db });
    await assert.rejects(repository.insertTransferEvents([
      event(FIRST_GUARDED_DAY, 4), event(DROPPED_GUARDED_DAY, 5),
    ]), /cannot recreate dropped transfer partition for 2199-01-03/);
    await assert.rejects(repository.ensurePartitionForDay(DROPPED_GUARDED_DAY),
      /cannot recreate dropped transfer partition for 2199-01-03/);
    const partitions = await db.query(
      `SELECT to_regclass('robinhood_token_transfer_events_2199_01_02') AS first,
              to_regclass('robinhood_token_transfer_events_2199_01_03') AS dropped`
    );
    assert.deepEqual(partitions.rows[0], { first: null, dropped: null });
  });
});
