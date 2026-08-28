const db = require('./db');

const DEFAULT_RETENTION_BLOCKS = 20_000;
const DEFAULT_BATCH_LIMIT = 5_000;

function boundedInteger(value, fallback, min, max, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function normalizeOptions(options = {}) {
  return Object.freeze({
    retentionBlocks: boundedInteger(
      options.retentionBlocks, DEFAULT_RETENTION_BLOCKS,
      1, 1_000_000, 'holderJournal.retentionBlocks'
    ),
    batchLimit: boundedInteger(
      options.batchLimit, DEFAULT_BATCH_LIMIT,
      1, 50_000, 'holderJournal.batchLimit'
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
    `SELECT next_block, journal_floor_block
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
    `SELECT 1 FROM robinhood_holder_transfer_journal journal
      WHERE journal.chain = 'robinhood' AND journal.applied = false
        AND journal.block_number < $1
        AND (EXISTS (
          SELECT 1 FROM robinhood_holder_token_states state
           WHERE state.chain = journal.chain AND state.token_address = journal.token_address
             AND state.ledger_status <> 'drifted'
        ) OR EXISTS (
          SELECT 1 FROM robinhood_holder_global_backfill_tokens token
          INNER JOIN robinhood_holder_global_backfill_runs run
             ON run.id = token.run_id AND run.chain = token.chain
           WHERE token.chain = journal.chain AND token.token_address = journal.token_address
             AND token.status = 'active' AND run.barrier_block IS NOT NULL
             AND run.status <> 'completed'
        ))
      LIMIT 1`,
    [cutoffBlock]
  );
  return result.rowCount > 0;
}

async function deleteExpiredBufferedBatch(client, cutoffBlock, batchLimit) {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT journal.chain, journal.transaction_hash, journal.log_index
         FROM robinhood_holder_transfer_journal journal
        WHERE journal.chain = 'robinhood' AND journal.applied = false
          AND journal.block_number < $1
          AND NOT EXISTS (
            SELECT 1 FROM robinhood_holder_token_states state
             WHERE state.chain = journal.chain AND state.token_address = journal.token_address
               AND state.ledger_status <> 'drifted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM robinhood_holder_global_backfill_tokens token
            INNER JOIN robinhood_holder_global_backfill_runs run
               ON run.id = token.run_id AND run.chain = token.chain
             WHERE token.chain = journal.chain AND token.token_address = journal.token_address
               AND token.status = 'active' AND run.barrier_block IS NOT NULL
               AND run.status <> 'completed'
          )
        ORDER BY journal.block_number, journal.transaction_index, journal.log_index
        LIMIT $2::int
        FOR UPDATE OF journal
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

async function deleteAppliedBatch(client, cutoffBlock, batchLimit) {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
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
    `SELECT 1 FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND block_number < $1 LIMIT 1`,
    [cutoffBlock]
  );
  return result.rowCount > 0;
}

async function advanceFloor(client, cutoffBlock) {
  const result = await client.query(
    `UPDATE robinhood_holder_cursors
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
      const cutoffBlock = nextBlock > retained ? nextBlock - retained : 0n;
      if (cutoffBlock <= floorBlock) {
        return Object.freeze({
          status: 'idle', deletedEvents: 0, discardedBufferedEvents: 0,
          cutoffBlock: cutoffBlock.toString(), journalFloorBlock: floorBlock.toString(),
        });
      }
      const discardedBufferedEvents = await deleteExpiredBufferedBatch(
        client, cutoffBlock.toString(), normalized.batchLimit
      );
      if (await hasOldPendingEvent(client, cutoffBlock.toString())) {
        return Object.freeze({
          status: 'blocked', reason: 'pending_event_before_cutoff', deletedEvents: 0,
          discardedBufferedEvents,
          cutoffBlock: cutoffBlock.toString(), journalFloorBlock: floorBlock.toString(),
        });
      }
      const deletedEvents = await deleteAppliedBatch(
        client, cutoffBlock.toString(), normalized.batchLimit
      );
      if (await hasOlderJournalEvent(client, cutoffBlock.toString())) {
        return Object.freeze({
          status: 'draining', deletedEvents, discardedBufferedEvents,
          cutoffBlock: cutoffBlock.toString(), journalFloorBlock: floorBlock.toString(),
        });
      }
      const journalFloorBlock = await advanceFloor(client, cutoffBlock.toString());
      return Object.freeze({
        status: 'pruned', deletedEvents, discardedBufferedEvents,
        cutoffBlock: cutoffBlock.toString(), journalFloorBlock,
      });
    });
  }

  return Object.freeze({ pruneOnce });
}

module.exports = {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_RETENTION_BLOCKS,
  createRobinhoodHolderJournalRetention,
  __private: { normalizeOptions },
};
