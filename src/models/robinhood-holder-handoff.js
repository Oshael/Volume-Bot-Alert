const db = require('./db');

function tokenAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error('tokenAddress is invalid');
  return normalized;
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function lockLiveCursor(client) {
  const result = await client.query(
    `SELECT next_block, safe_head, checkpoint_block, checkpoint_hash,
            journal_floor_block, version
       FROM robinhood_holder_cursors
      WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
  );
  if (!result.rowCount) throw codedError('holder live cursor is missing', 'holder_cursor_missing');
  const row = result.rows[0];
  if (row.journal_floor_block == null) {
    throw codedError('holder journal floor is not initialized', 'holder_journal_floor_uninitialized');
  }
  if (row.checkpoint_block == null || row.checkpoint_hash == null
      || BigInt(row.checkpoint_block) + 1n !== BigInt(row.next_block)) {
    throw codedError('holder live cursor checkpoint is inconsistent', 'holder_cursor_corrupt');
  }
  return row;
}

async function lockBackfillState(client, token) {
  const result = await client.query(
    `SELECT holder_count, deployment_block, backfill_next_block,
            live_through_block, live_through_hash, version
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'backfilling' FOR UPDATE`,
    [token]
  );
  if (!result.rowCount) {
    throw codedError('holder token is not available for handoff', 'holder_handoff_unavailable');
  }
  const row = result.rows[0];
  if (row.backfill_next_block == null || row.live_through_block == null
      || row.live_through_hash == null
      || BigInt(row.live_through_block) + 1n !== BigInt(row.backfill_next_block)) {
    throw codedError('holder backfill checkpoint is inconsistent', 'holder_handoff_checkpoint_gap');
  }
  return row;
}

function validateCoverage(cursor, state) {
  const floor = BigInt(cursor.journal_floor_block);
  const backfillNext = BigInt(state.backfill_next_block);
  const liveNext = BigInt(cursor.next_block);
  if (backfillNext < floor) {
    throw codedError('holder backfill cursor is below retained live coverage', 'holder_handoff_below_floor');
  }
  if (backfillNext > liveNext) {
    throw codedError('holder live cursor has not reached backfill', 'holder_handoff_live_behind');
  }
  if (backfillNext < liveNext
      || String(state.live_through_block) !== String(cursor.checkpoint_block)
      || state.live_through_hash !== cursor.checkpoint_hash) {
    throw codedError('holder backfill is not at the exact live barrier', 'holder_handoff_not_at_barrier');
  }
}

async function lockCoveredJournal(client, token, liveNextBlock) {
  const result = await client.query(
    `SELECT block_number, transaction_hash, log_index, applied
       FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND token_address = $1 AND block_number < $2
      ORDER BY block_number, transaction_index, log_index
      FOR UPDATE`,
    [token, liveNextBlock]
  );
  if (result.rows.some((row) => row.applied)) {
    throw codedError('backfilling token already has applied live events', 'holder_handoff_applied_overlap');
  }
  return result.rows;
}

async function deleteBackfilledOverlap(client, token, backfillNextBlock) {
  const result = await client.query(
    `DELETE FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND token_address = $1
        AND block_number < $2 AND applied = false`,
    [token, backfillNextBlock]
  );
  return result.rowCount;
}

async function promoteState(client, token, state) {
  const result = await client.query(
    `UPDATE robinhood_holder_token_states
        SET ledger_status = 'shadow', version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'backfilling' AND version = $2
        AND backfill_next_block = $3
      RETURNING holder_count, version`,
    [token, state.version, state.backfill_next_block]
  );
  if (!result.rowCount) {
    throw codedError('holder backfill changed during handoff', 'holder_handoff_stale');
  }
  return result.rows[0];
}

function createRobinhoodHolderHandoffRepository(options = {}) {
  const database = options.database || db;

  async function promoteAtLiveBarrier(input = {}) {
    const token = tokenAddress(input.tokenAddress);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursor = await lockLiveCursor(client);
      const state = await lockBackfillState(client, token);
      validateCoverage(cursor, state);
      const journal = await lockCoveredJournal(client, token, cursor.next_block);
      const discardedOverlapEvents = await deleteBackfilledOverlap(
        client, token, state.backfill_next_block
      );
      if (discardedOverlapEvents !== journal.length) {
        throw codedError('holder handoff overlap changed while locked', 'holder_handoff_stale');
      }
      const promoted = await promoteState(client, token, state);
      await client.query('COMMIT');
      return Object.freeze({
        status: 'shadow', tokenAddress: token,
        holderCount: String(promoted.holder_count), version: Number(promoted.version),
        discardedOverlapEvents,
        journalFloorBlock: String(cursor.journal_floor_block),
        liveCursorNextBlock: String(cursor.next_block),
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ promoteAtLiveBarrier });
}

module.exports = {
  createRobinhoodHolderHandoffRepository,
  __private: { validateCoverage },
};
