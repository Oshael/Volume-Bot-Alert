\set QUIET 1
\set ON_ERROR_STOP 1

SET enable_mergejoin = off;

COPY (
  WITH protected_tokens AS MATERIALIZED (
    SELECT token_address
      FROM robinhood_holder_token_states
     WHERE chain = 'robinhood' AND ledger_status <> 'drifted'
    UNION
    SELECT token.token_address
      FROM robinhood_holder_global_backfill_tokens token
      JOIN robinhood_holder_global_backfill_runs run
        ON run.id = token.run_id AND run.chain = token.chain
     WHERE token.chain = 'robinhood' AND token.status = 'active'
       AND run.barrier_block IS NOT NULL AND run.status <> 'completed'
  ), bounds AS MATERIALIZED (
    SELECT GREATEST(next_block - 20000, 0) AS cutoff_block
      FROM robinhood_holder_cursors
     WHERE chain = 'robinhood' AND stream = 'live'
  )
  SELECT recent.*
    FROM robinhood_holder_transfer_journal recent
    CROSS JOIN bounds
   WHERE recent.chain = 'robinhood'
     AND recent.block_number >= bounds.cutoff_block
  UNION ALL
  SELECT pending.*
    FROM robinhood_holder_transfer_journal pending
    INNER JOIN protected_tokens protected
      ON protected.token_address = pending.token_address
    CROSS JOIN bounds
   WHERE pending.chain = 'robinhood' AND pending.applied = false
     AND pending.block_number < bounds.cutoff_block
) TO STDOUT;
