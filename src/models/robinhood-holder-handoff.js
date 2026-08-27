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

function verifiedCheckpoint(value = {}) {
  const number = String(value.number ?? '').trim();
  const hash = String(value.hash || '').trim().toLowerCase();
  if (!/^\d+$/.test(number) || !/^0x[0-9a-f]{64}$/.test(hash)) {
    throw codedError('holder handoff checkpoint is invalid', 'holder_handoff_checkpoint_unverified');
  }
  return Object.freeze({ number: BigInt(number).toString(), hash });
}

function candidateRow(row) {
  if (!row) return null;
  return Object.freeze({
    tokenAddress: row.token_address,
    backfillNextBlock: String(row.backfill_next_block),
    checkpoint: Object.freeze({
      number: String(row.live_through_block), hash: row.live_through_hash,
    }),
    version: Number(row.version),
  });
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
  if (backfillNext === liveNext
      && (String(state.live_through_block) !== String(cursor.checkpoint_block)
        || state.live_through_hash !== cursor.checkpoint_hash)) {
    throw codedError('holder backfill is not at the exact live barrier', 'holder_handoff_not_at_barrier');
  }
}

function validateVerifiedCheckpoint(state, value) {
  const checkpoint = verifiedCheckpoint(value);
  if (checkpoint.number !== String(state.live_through_block)
      || checkpoint.hash !== state.live_through_hash) {
    throw codedError(
      'holder handoff checkpoint was not verified', 'holder_handoff_checkpoint_unverified'
    );
  }
}

async function hasAppliedBackfilledOverlap(client, token, backfillNextBlock) {
  const result = await client.query(
    `SELECT 1
       FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND token_address = $1
        AND block_number < $2 AND applied = true
      LIMIT 1`,
    [token, backfillNextBlock]
  );
  return result.rowCount > 0;
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

  async function getNextCandidate() {
    const result = await database.query(
      `WITH candidate AS MATERIALIZED (
         SELECT state.token_address, state.backfill_next_block,
                state.live_through_block, state.live_through_hash, state.version
           FROM robinhood_holder_token_states state
           INNER JOIN robinhood_holder_cursors cursor
             ON cursor.chain = state.chain AND cursor.stream = 'live'
          WHERE state.chain = 'robinhood' AND state.ledger_status = 'backfilling'
            AND cursor.journal_floor_block IS NOT NULL
            AND state.backfill_next_block BETWEEN cursor.journal_floor_block AND cursor.next_block
            AND state.live_through_block + 1 = state.backfill_next_block
            AND state.live_through_hash IS NOT NULL
            AND state.backfill_next_block >= COALESCE((
              SELECT journal.block_number
                FROM robinhood_holder_transfer_journal journal
               WHERE journal.chain = state.chain
                 AND journal.token_address = state.token_address
                 AND journal.applied = false
               ORDER BY journal.block_number, journal.transaction_index, journal.log_index
               LIMIT 1
            ), state.backfill_next_block)
          ORDER BY state.backfill_next_block DESC, state.token_address
          LIMIT 1
       )
       SELECT candidate.* FROM candidate`
    );
    return candidateRow(result.rows[0]);
  }

  async function markResyncing(input = {}) {
    const token = tokenAddress(input.tokenAddress);
    const version = Number(input.version);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw codedError('holder handoff version is invalid', 'holder_handoff_stale');
    }
    const result = await database.query(
      `UPDATE robinhood_holder_token_states
          SET ledger_status = 'resyncing', version = version + 1, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'backfilling' AND version = $2
        RETURNING token_address`,
      [token, version]
    );
    if (!result.rowCount) {
      throw codedError('holder handoff candidate changed', 'holder_handoff_stale');
    }
    return Object.freeze({ status: 'resyncing', tokenAddress: token });
  }

  async function promoteAtLiveBarrier(input = {}) {
    const token = tokenAddress(input.tokenAddress);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursor = await lockLiveCursor(client);
      const state = await lockBackfillState(client, token);
      validateVerifiedCheckpoint(state, input.verifiedCheckpoint);
      validateCoverage(cursor, state);
      if (await hasAppliedBackfilledOverlap(client, token, state.backfill_next_block)) {
        throw codedError(
          'backfilling token already has applied live events', 'holder_handoff_applied_overlap'
        );
      }
      const discardedOverlapEvents = await deleteBackfilledOverlap(
        client, token, state.backfill_next_block
      );
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

  return Object.freeze({ getNextCandidate, markResyncing, promoteAtLiveBarrier });
}

module.exports = {
  createRobinhoodHolderHandoffRepository,
  __private: { validateCoverage, validateVerifiedCheckpoint },
};
