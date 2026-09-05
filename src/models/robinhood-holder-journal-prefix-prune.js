// Caller owns the live cursor lock and the shared reorg fence for the transaction.
async function oldestBatch(client, cutoffBlock, batchLimit) {
  const result = await client.query(
    `/* holder-prune:select_prefix */ SELECT chain, block_number, transaction_hash,
            log_index, token_address, applied
       FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND block_number < $1
      ORDER BY block_number, log_index
      LIMIT $2::int FOR UPDATE`,
    [cutoffBlock, batchLimit + 1]
  );
  // The extra row proves whether the last block would be split. Never skip locks:
  // a skipped earlier row would invalidate the claimed contiguous prefix.
  const boundary = result.rows.length > batchLimit
    ? BigInt(result.rows[batchLimit].block_number) : BigInt(cutoffBlock);
  return {
    rows: result.rows.filter((row) => BigInt(row.block_number) < boundary),
    boundary: boundary.toString(),
    split: result.rows.length > batchLimit,
  };
}

async function protectedTokens(client, rows) {
  const addresses = [...new Set(rows.filter((row) => !row.applied).map((row) => row.token_address))];
  if (!addresses.length) return new Set();
  const result = await client.query(
    `/* holder-prune:check_prefix */ SELECT token_address
       FROM unnest($1::varchar[]) AS candidate(token_address)
      WHERE EXISTS (
        SELECT 1 FROM robinhood_holder_token_states state
         WHERE state.chain = 'robinhood' AND state.token_address = candidate.token_address
           AND state.ledger_status <> 'drifted'
      ) OR EXISTS (
        SELECT 1 FROM robinhood_holder_global_backfill_runs run
        JOIN robinhood_holder_global_backfill_tokens token
          ON token.run_id = run.id AND token.chain = run.chain
         WHERE run.chain = 'robinhood' AND run.status <> 'completed'
           AND run.barrier_block IS NOT NULL AND token.status = 'active'
           AND token.token_address = candidate.token_address
      )`, [addresses]
  );
  return new Set(result.rows.map((row) => row.token_address));
}

async function deletePrefix(client, rows) {
  if (!rows.length) return { deletedEvents: 0, discardedBufferedEvents: 0 };
  const result = await client.query(
    `/* holder-prune:delete_prefix */ DELETE FROM robinhood_holder_transfer_journal journal
      USING unnest($1::varchar[], $2::int[]) AS selected(transaction_hash, log_index)
      WHERE journal.chain = 'robinhood'
        AND journal.transaction_hash = selected.transaction_hash
        AND journal.log_index = selected.log_index
        AND (journal.applied OR (
          NOT EXISTS (
            SELECT 1 FROM robinhood_holder_token_states state
             WHERE state.chain = journal.chain AND state.token_address = journal.token_address
               AND state.ledger_status <> 'drifted'
          ) AND NOT EXISTS (
            SELECT 1 FROM robinhood_holder_global_backfill_tokens token
            JOIN robinhood_holder_global_backfill_runs run
              ON run.id = token.run_id AND run.chain = token.chain
             WHERE token.chain = journal.chain AND token.token_address = journal.token_address
               AND token.status = 'active' AND run.barrier_block IS NOT NULL
               AND run.status <> 'completed'
          )
        ))
      RETURNING journal.applied`,
    [rows.map((row) => row.transaction_hash), rows.map((row) => row.log_index)]
  );
  if (result.rowCount !== rows.length) throw new Error('holder journal prefix changed during deletion');
  return {
    deletedEvents: result.rows.filter((row) => row.applied).length,
    discardedBufferedEvents: result.rows.filter((row) => !row.applied).length,
  };
}

async function pruneJournalPrefix(client, { cutoffBlock, floorBlock, batchLimit }) {
  const batch = await oldestBatch(client, cutoffBlock, batchLimit);
  const base = { deletedEvents: 0, discardedBufferedEvents: 0,
    cutoffBlock: String(cutoffBlock), journalFloorBlock: String(floorBlock) };
  if (!batch.rows.length && batch.split) {
    return { ...base, status: 'blocked', reason: 'batch_limit_splits_block',
      blockedBlock: batch.boundary };
  }
  const protectedSet = await protectedTokens(client, batch.rows);
  const blocked = batch.rows.find((row) => !row.applied && protectedSet.has(row.token_address));
  const boundary = blocked ? String(blocked.block_number) : batch.boundary;
  // Preserve the entire blocked block, including its already-applied events.
  const deletable = batch.rows.filter((row) => BigInt(row.block_number) < BigInt(boundary));
  if (blocked && !deletable.length) {
    return { ...base, status: 'blocked', reason: 'pending_event_before_cutoff', blockedBlock: boundary };
  }
  const counts = await deletePrefix(client, deletable);
  const newFloor = BigInt(boundary) > BigInt(floorBlock) ? boundary : String(floorBlock);
  const advanced = await client.query(
    `/* holder-prune:advance_floor */ UPDATE robinhood_holder_cursors
        SET journal_floor_block = $1, updated_at = NOW()
      WHERE chain = 'robinhood' AND stream = 'live'
        AND journal_floor_block = $2 AND next_block >= $1
      RETURNING journal_floor_block`, [newFloor, String(floorBlock)]
  );
  if (advanced.rowCount !== 1) throw new Error('holder journal prefix floor changed');
  return { ...base, ...counts, journalFloorBlock: String(advanced.rows[0].journal_floor_block),
    status: blocked ? 'blocked' : (batch.split ? 'draining' : 'pruned'),
    ...(blocked ? { reason: 'pending_event_before_cutoff', blockedBlock: boundary } : {}) };
}

module.exports = { pruneJournalPrefix };
