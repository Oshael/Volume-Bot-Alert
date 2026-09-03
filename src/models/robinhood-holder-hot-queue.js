// The caller must hold the token's apply/state lock inside a transaction.
async function refreshExistingHotQueue(client, tokenAddress) {
  // Lock before taking the journal snapshot. An enqueue already in flight must
  // commit first; later enqueues wait and merge their bounds after our commit.
  const locked = await client.query(
    `SELECT 1 FROM robinhood_holder_hot_queue
      WHERE chain = 'robinhood' AND token_address = $1 FOR UPDATE`,
    [tokenAddress]
  );
  if (!locked.rowCount) return false;

  // Both probes use the existing pending-token index. Never aggregate all
  // captured_at values after each small apply batch. Keep the ticket's time
  // envelope until drained: its age is conservative, not exact pending age.
  await client.query(
    `WITH first_pending AS MATERIALIZED (
       SELECT block_number FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND token_address = $1 AND applied = false
        ORDER BY block_number, transaction_index, log_index LIMIT 1
     ), last_pending AS MATERIALIZED (
       SELECT block_number FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND token_address = $1 AND applied = false
        ORDER BY block_number DESC, transaction_index DESC, log_index DESC LIMIT 1
     ), refreshed AS (
       UPDATE robinhood_holder_hot_queue queue
          SET first_pending_block = first_pending.block_number,
              last_pending_block = last_pending.block_number, updated_at = NOW()
         FROM first_pending CROSS JOIN last_pending
        WHERE queue.chain = 'robinhood' AND queue.token_address = $1
       RETURNING queue.token_address
     )
     DELETE FROM robinhood_holder_hot_queue queue
      WHERE queue.chain = 'robinhood' AND queue.token_address = $1
        AND NOT EXISTS (SELECT 1 FROM first_pending)`,
    [tokenAddress]
  );
  return true;
}

module.exports = { refreshExistingHotQueue };
