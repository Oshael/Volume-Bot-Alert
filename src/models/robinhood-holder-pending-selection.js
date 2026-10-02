const MAX_FAST_PENDING_TOKENS = 512;

// Seek once per distinct pending token using idx_rh_holder_journal_pending_token.
// The extra token witnesses overflow, including untracked/ineligible pendencies.
// Both branches share one statement snapshot and rank each token's earliest event.
const PENDING_TOKEN_SELECTION_SQL = `WITH RECURSIVE pending AS (
  (SELECT journal.token_address, journal.block_number,
          journal.transaction_index, journal.log_index, 1 AS ordinal
     FROM robinhood_holder_transfer_journal journal
    WHERE journal.chain = 'robinhood' AND journal.applied = false
    ORDER BY journal.token_address, journal.block_number,
             journal.transaction_index, journal.log_index
    LIMIT 1)
  UNION ALL
  SELECT next_pending.*, previous.ordinal + 1
    FROM pending previous
    CROSS JOIN LATERAL (
      SELECT journal.token_address, journal.block_number,
             journal.transaction_index, journal.log_index
        FROM robinhood_holder_transfer_journal journal
       WHERE journal.chain = 'robinhood' AND journal.applied = false
         AND journal.token_address > previous.token_address
       ORDER BY journal.token_address, journal.block_number,
                journal.transaction_index, journal.log_index
       LIMIT 1
    ) next_pending
   WHERE previous.ordinal < ${MAX_FAST_PENDING_TOKENS + 1}
), walk_complete AS MATERIALIZED (
  SELECT COALESCE(MAX(ordinal), 0) < ${MAX_FAST_PENDING_TOKENS + 1} AS complete FROM pending
)
SELECT ranked.token_address
  FROM (
    SELECT state.token_address, pending.block_number, pending.transaction_index,
           pending.log_index, state.ledger_status
      FROM pending
      INNER JOIN robinhood_holder_token_states state
        ON state.chain = 'robinhood' AND state.token_address = pending.token_address
     WHERE (SELECT complete FROM walk_complete)
       AND state.chain = 'robinhood'
       AND state.ledger_status IN ('shadow', 'live')
       AND NOT (state.token_address = ANY($1::varchar[]))
       AND mod(
         hashtextextended(state.token_address, 0) & 9223372036854775807,
         $3::bigint
       ) = $4::bigint
    UNION ALL
    SELECT state.token_address, pending.block_number, pending.transaction_index,
           pending.log_index, state.ledger_status
      FROM robinhood_holder_token_states state
      INNER JOIN LATERAL (
        SELECT journal.block_number, journal.transaction_index, journal.log_index
          FROM robinhood_holder_transfer_journal journal
         WHERE journal.chain = state.chain
           AND journal.token_address = state.token_address
           AND journal.applied = false
         ORDER BY journal.block_number, journal.transaction_index, journal.log_index
         LIMIT 1
      ) pending ON true
     WHERE NOT (SELECT complete FROM walk_complete)
       AND state.chain = 'robinhood'
       AND state.ledger_status IN ('shadow', 'live')
       AND NOT (state.token_address = ANY($1::varchar[]))
       AND mod(
         hashtextextended(state.token_address, 0) & 9223372036854775807,
         $3::bigint
       ) = $4::bigint
  ) ranked
 ORDER BY ranked.block_number DESC, ranked.transaction_index DESC, ranked.log_index DESC,
          (ranked.ledger_status = 'live') DESC, ranked.token_address
 LIMIT $2::int`;

module.exports = { PENDING_TOKEN_SELECTION_SQL };
