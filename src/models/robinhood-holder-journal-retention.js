const db = require('./db');
const { pruneJournalPrefix } = require('./robinhood-holder-journal-prefix-prune');

const DEFAULT_RETENTION_BLOCKS = 20_000;
const DEFAULT_BATCH_LIMIT = 5_000;
const DEFAULT_SCAN_PAGE_LIMIT = 20_000;

function boundedInteger(value, fallback, min, max, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function normalizeOptions(options = {}) {
  const beforeBlock = options.beforeBlock == null ? null : String(options.beforeBlock);
  if (beforeBlock !== null && (!/^(0|[1-9][0-9]*)$/.test(beforeBlock)
    || BigInt(beforeBlock) > 9223372036854775807n
    || (typeof options.beforeBlock === 'number' && !Number.isSafeInteger(options.beforeBlock)))) {
    throw new Error('holderJournal.beforeBlock is invalid');
  }
  return Object.freeze({
    beforeBlock,
    retentionBlocks: boundedInteger(
      options.retentionBlocks, DEFAULT_RETENTION_BLOCKS,
      1, 1_000_000, 'holderJournal.retentionBlocks'
    ),
    batchLimit: boundedInteger(
      options.batchLimit, DEFAULT_BATCH_LIMIT,
      1, 50_000, 'holderJournal.batchLimit'
    ),
    scanPageLimit: boundedInteger(
      options.scanPageLimit, DEFAULT_SCAN_PAGE_LIMIT,
      1, 50_000, 'holderJournal.scanPageLimit'
    ),
  });
}

async function withTransaction(database, operation) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function lockCursor(client) {
  const result = await client.query(
    `/* holder-prune:lock_cursor */ SELECT next_block, journal_floor_block
       FROM robinhood_holder_cursors
      WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
  );
  if (!result.rowCount) {
    const error = new Error('holder live cursor is missing');
    error.code = 'holder_cursor_missing';
    throw error;
  }
  return result.rows[0];
}

async function hasOldPendingEvent(client, cutoffBlock) {
  const result = await client.query(
    `/* holder-prune:check_protected */ WITH protected_tokens AS (
       SELECT chain, token_address FROM robinhood_holder_token_states
        WHERE chain = 'robinhood' AND ledger_status <> 'drifted'
       UNION
       SELECT token.chain, token.token_address
         FROM robinhood_holder_global_backfill_tokens token
         JOIN robinhood_holder_global_backfill_runs run
           ON run.id = token.run_id AND run.chain = token.chain
        WHERE token.chain = 'robinhood' AND token.status = 'active'
          AND run.barrier_block IS NOT NULL AND run.status <> 'completed'
     )
     SELECT 1 FROM protected_tokens token
      CROSS JOIN LATERAL (
        SELECT 1 FROM robinhood_holder_transfer_journal journal
         WHERE journal.chain = token.chain AND journal.token_address = token.token_address
           AND journal.applied = false AND journal.block_number < $1
         LIMIT 1
      ) pending
      LIMIT 1`,
    [cutoffBlock]
  );
  return result.rowCount > 0;
}

async function lockPruneScan(client) {
  const result = await client.query(
    `SELECT scan_cutoff_block, cursor_block_number, cursor_transaction_index,
            cursor_log_index, cursor_transaction_hash
       FROM robinhood_holder_journal_prune_scans
      WHERE chain = 'robinhood' FOR UPDATE`
  );
  if (result.rowCount) return result.rows[0];
  const error = new Error('holder journal prune scan cursor is missing; apply Stage 229');
  error.code = 'holder_journal_prune_scan_missing';
  throw error;
}

async function scanExpiredBufferedPage(client, cutoffBlock, cursor, pageLimit, batchLimit) {
  const cursorFilter = cursor == null ? '' : `AND (
            journal.block_number, journal.transaction_index,
            journal.log_index, journal.transaction_hash
          ) > ($4::bigint, $5::integer, $6::integer, $7::varchar(66))`;
  const params = [cutoffBlock, pageLimit, batchLimit];
  if (cursor != null) params.push(
    cursor.blockNumber, cursor.transactionIndex, cursor.logIndex, cursor.transactionHash
  );
  const result = await client.query(
    `/* holder-prune:delete_buffered_page */ WITH page AS MATERIALIZED (
       SELECT journal.chain, journal.block_number, journal.transaction_index,
              journal.log_index, journal.transaction_hash, journal.token_address
         FROM robinhood_holder_transfer_journal journal
        WHERE journal.chain = 'robinhood' AND journal.applied = false
          AND journal.block_number < $1
          ${cursorFilter}
        ORDER BY journal.block_number, journal.transaction_index,
                 journal.log_index, journal.transaction_hash
        LIMIT $2::int
     ), eligible AS MATERIALIZED (
       SELECT page.chain, page.block_number, page.transaction_index,
              page.log_index, page.transaction_hash
         FROM page
         LEFT JOIN LATERAL (
           SELECT true AS protected
             FROM robinhood_holder_token_states state
            WHERE state.chain = page.chain AND state.token_address = page.token_address
              AND state.ledger_status <> 'drifted'
            LIMIT 1
         ) state_guard ON true
         LEFT JOIN LATERAL (
           SELECT true AS protected
             FROM robinhood_holder_global_backfill_tokens token
             JOIN robinhood_holder_global_backfill_runs run
               ON run.id = token.run_id AND run.chain = token.chain
            WHERE token.chain = page.chain AND token.token_address = page.token_address
              AND token.status = 'active' AND run.barrier_block IS NOT NULL
              AND run.status <> 'completed'
            LIMIT 1
         ) backfill_guard ON true
        WHERE state_guard.protected IS NULL AND backfill_guard.protected IS NULL
        ORDER BY page.block_number, page.transaction_index,
                 page.log_index, page.transaction_hash
        LIMIT $3::int
     ), deleted AS (
     DELETE FROM robinhood_holder_transfer_journal journal
     USING eligible
      WHERE journal.chain = eligible.chain
        AND journal.transaction_hash = eligible.transaction_hash
        AND journal.log_index = eligible.log_index
        AND journal.applied = false AND journal.block_number < $1
      RETURNING 1
     )
     SELECT (SELECT COUNT(*)::int FROM page) AS scanned,
            (SELECT COUNT(*)::int FROM eligible) AS selected,
            (SELECT COUNT(*)::int FROM deleted) AS deleted,
            (SELECT jsonb_build_object(
              'blockNumber', block_number::text,
              'transactionIndex', transaction_index,
              'logIndex', log_index,
              'transactionHash', transaction_hash
            ) FROM page ORDER BY block_number DESC, transaction_index DESC,
                 log_index DESC, transaction_hash DESC LIMIT 1) AS page_cursor,
            (SELECT jsonb_build_object(
              'blockNumber', block_number::text,
              'transactionIndex', transaction_index,
              'logIndex', log_index,
              'transactionHash', transaction_hash
            ) FROM eligible ORDER BY block_number DESC, transaction_index DESC,
                 log_index DESC, transaction_hash DESC LIMIT 1) AS eligible_cursor`,
    params
  );
  return result.rows[0];
}

async function savePruneScan(client, cutoffBlock, cursor) {
  await client.query(
    `UPDATE robinhood_holder_journal_prune_scans
        SET scan_cutoff_block = $1, cursor_block_number = $2,
            cursor_transaction_index = $3, cursor_log_index = $4,
            cursor_transaction_hash = $5, updated_at = NOW()
      WHERE chain = 'robinhood'`,
    [cutoffBlock, cursor.blockNumber, cursor.transactionIndex,
      cursor.logIndex, cursor.transactionHash]
  );
}

async function completePruneScan(client) {
  await client.query(
    `UPDATE robinhood_holder_journal_prune_scans
        SET scan_cutoff_block = NULL, cursor_block_number = NULL,
            cursor_transaction_index = NULL, cursor_log_index = NULL,
            cursor_transaction_hash = NULL, completed_passes = completed_passes + 1,
            last_pass_completed_at = NOW(), updated_at = NOW()
      WHERE chain = 'robinhood'`
  );
}

function scanPosition(scanState, floorBlock, cutoffBlock) {
  const savedCutoff = scanState.scan_cutoff_block == null
    ? null : BigInt(scanState.scan_cutoff_block);
  const resume = savedCutoff !== null && savedCutoff > floorBlock
    && savedCutoff <= cutoffBlock
    && (scanState.cursor_block_number == null
      || BigInt(scanState.cursor_block_number) >= floorBlock);
  return {
    cutoff: resume ? savedCutoff : cutoffBlock,
    cursor: !resume || scanState.cursor_block_number == null ? null : {
      blockNumber: String(scanState.cursor_block_number),
      transactionIndex: Number(scanState.cursor_transaction_index),
      logIndex: Number(scanState.cursor_log_index),
      transactionHash: scanState.cursor_transaction_hash,
    },
  };
}

async function deleteAppliedBatch(client, cutoffBlock, batchLimit) {
  const result = await client.query(
    `/* holder-prune:delete_applied */ WITH candidates AS MATERIALIZED (
       SELECT chain, transaction_hash, log_index
         FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND applied = true AND block_number < $1
        ORDER BY block_number, transaction_index, log_index
        LIMIT $2::int
        FOR UPDATE
     )
     DELETE FROM robinhood_holder_transfer_journal journal
     USING candidates
      WHERE journal.chain = candidates.chain
        AND journal.transaction_hash = candidates.transaction_hash
        AND journal.log_index = candidates.log_index`,
    [cutoffBlock, batchLimit]
  );
  return result.rowCount;
}

async function hasOlderJournalEvent(client, cutoffBlock) {
  const result = await client.query(
    `/* holder-prune:check_remaining */ SELECT 1 FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND block_number < $1 LIMIT 1`,
    [cutoffBlock]
  );
  return result.rowCount > 0;
}

async function advanceFloor(client, cutoffBlock) {
  await client.query(
    `DELETE FROM robinhood_holder_capture_receipts
      WHERE chain = 'robinhood' AND block_number < $1`,
    [cutoffBlock]
  );
  const result = await client.query(
    `/* holder-prune:advance_floor */ UPDATE robinhood_holder_cursors
        SET journal_floor_block = $1, updated_at = NOW()
      WHERE chain = 'robinhood' AND stream = 'live'
        AND journal_floor_block <= $1 AND next_block >= $1
      RETURNING journal_floor_block`,
    [cutoffBlock]
  );
  if (!result.rowCount) throw new Error('holder journal floor rejected an ordered advance');
  return String(result.rows[0].journal_floor_block);
}

function createRobinhoodHolderJournalRetention(options = {}) {
  const database = options.database || db;

  async function pruneOnce(input = {}) {
    const normalized = normalizeOptions(input);
    return withTransaction(database, async (client) => {
      const cursor = await lockCursor(client);
      if (cursor.journal_floor_block == null) {
        return Object.freeze({
          status: 'blocked', reason: 'journal_floor_uninitialized', deletedEvents: 0,
        });
      }
      const nextBlock = BigInt(cursor.next_block);
      const floorBlock = BigInt(cursor.journal_floor_block);
      const retained = BigInt(normalized.retentionBlocks);
      const retentionCutoff = nextBlock > retained ? nextBlock - retained : 0n;
      const requestedCutoff = normalized.beforeBlock == null
        ? retentionCutoff : BigInt(normalized.beforeBlock);
      const cutoffBlock = requestedCutoff < retentionCutoff ? requestedCutoff : retentionCutoff;
      if (cutoffBlock <= floorBlock) {
        return Object.freeze({
          status: 'idle', deletedEvents: 0, discardedBufferedEvents: 0,
          cutoffBlock: cutoffBlock.toString(), journalFloorBlock: floorBlock.toString(),
        });
      }
      if (normalized.beforeBlock !== null) {
        return Object.freeze(await pruneJournalPrefix(client, {
          cutoffBlock: cutoffBlock.toString(), floorBlock: floorBlock.toString(),
          batchLimit: normalized.batchLimit,
        }));
      }
      const scanState = await lockPruneScan(client);
      const { cutoff: scanCutoff, cursor: scanCursor } = scanPosition(
        scanState, floorBlock, cutoffBlock
      );
      const scan = await scanExpiredBufferedPage(
        client, scanCutoff.toString(), scanCursor,
        normalized.scanPageLimit, normalized.batchLimit
      );
      const discardedBufferedEvents = Number(scan.deleted);
      const scannedBufferedEvents = Number(scan.scanned);
      const bounded = Number(scan.selected) === normalized.batchLimit
        || scannedBufferedEvents === normalized.scanPageLimit;
      if (bounded) {
        const nextCursor = Number(scan.selected) === normalized.batchLimit
          ? scan.eligible_cursor : scan.page_cursor;
        await savePruneScan(client, scanCutoff.toString(), nextCursor);
        return Object.freeze({
          status: 'draining', deletedEvents: 0, discardedBufferedEvents,
          scannedBufferedEvents, cutoffBlock: scanCutoff.toString(),
          journalFloorBlock: floorBlock.toString(),
        });
      }
      await completePruneScan(client);
      if (await hasOldPendingEvent(client, scanCutoff.toString())) {
        return Object.freeze({
          status: 'blocked', reason: 'pending_event_before_cutoff', deletedEvents: 0,
          discardedBufferedEvents, scannedBufferedEvents,
          cutoffBlock: scanCutoff.toString(), journalFloorBlock: floorBlock.toString(),
        });
      }
      const deletedEvents = await deleteAppliedBatch(
        client, scanCutoff.toString(), normalized.batchLimit
      );
      if (await hasOlderJournalEvent(client, scanCutoff.toString())) {
        return Object.freeze({
          status: 'draining', deletedEvents, discardedBufferedEvents, scannedBufferedEvents,
          cutoffBlock: scanCutoff.toString(), journalFloorBlock: floorBlock.toString(),
        });
      }
      const journalFloorBlock = await advanceFloor(client, scanCutoff.toString());
      return Object.freeze({
        status: 'pruned', deletedEvents, discardedBufferedEvents, scannedBufferedEvents,
        cutoffBlock: scanCutoff.toString(), journalFloorBlock,
      });
    });
  }

  return Object.freeze({ pruneOnce });
}

module.exports = {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_RETENTION_BLOCKS,
  DEFAULT_SCAN_PAGE_LIMIT,
  createRobinhoodHolderJournalRetention,
  __private: { normalizeOptions },
};
