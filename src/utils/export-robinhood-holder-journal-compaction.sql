\set QUIET 1
\set ON_ERROR_STOP 1

SET enable_mergejoin = off;
SET enable_nestloop = off;
SET enable_indexscan = off;
SET enable_bitmapscan = off;
SET work_mem = '256MB';

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
  SELECT journal.*
    FROM robinhood_holder_transfer_journal journal
    CROSS JOIN bounds
    LEFT JOIN protected_tokens protected
      ON protected.token_address = journal.token_address
   WHERE journal.chain = 'robinhood' AND (
     journal.block_number >= bounds.cutoff_block OR (
       journal.block_number < bounds.cutoff_block AND journal.applied = false
       AND protected.token_address IS NOT NULL
     )
   )
) TO STDOUT;
