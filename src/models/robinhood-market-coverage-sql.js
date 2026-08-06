/**
 * Shared market coverage frontier for split Robinhood workers.
 *
 * The legacy ingestion cursor remains the immutable start of historical
 * coverage. The end is the oldest non-terminal capture (strict processing
 * frontier), or the head checkpoint when the processing queue is empty.
 *
 * `blocked` (dead-letter) captures are not part of the live frontier: their
 * frozen evidence is retained (pruneExpiredCaptures only drops processed/
 * rejected) and can be reprocessed once the failure cause is fixed, but until
 * then they have no observation. Pinning coverage_end to a blocked capture's
 * old timestamp would freeze the frontier in the past forever, silently
 * blacking out every recent-window (5m/1h) volume and liquidity for all tokens.
 * We advance past them instead — the gap is a bounded set of not-yet-valued
 * swaps, recoverable on replay — while dead-letter depth stays visible via the
 * queue status health read.
 */
const MARKET_COVERAGE_CTES = `legacy_market_coverage AS (
  SELECT coverage_start_timestamp AS coverage_start_at
  FROM robinhood_ingestion_cursors
  WHERE chain = 'robinhood' AND stream = 'market'
),
market_head_cursor AS (
  SELECT next_block, safe_head, checkpoint_timestamp
  FROM robinhood_head_capture_cursors
  WHERE chain = 'robinhood' AND stream = 'market'
),
leased_market_frontier AS MATERIALIZED (
  SELECT block_number, transaction_index, log_index,
    evidence->>'timestampMs' AS timestamp_ms
  FROM robinhood_head_captures
  WHERE chain = 'robinhood' AND stream = 'market'
    AND processing_status = 'leased'
),
active_market_frontier AS (
  (SELECT block_number, transaction_index, log_index,
      evidence->>'timestampMs' AS timestamp_ms
   FROM robinhood_head_captures
   WHERE chain = 'robinhood' AND stream = 'market'
     AND processing_status = 'pending'
   ORDER BY block_number, transaction_index, log_index
   LIMIT 1)
  UNION ALL
  (SELECT block_number, transaction_index, log_index, timestamp_ms
   FROM leased_market_frontier
   ORDER BY block_number, transaction_index, log_index
   LIMIT 1)
),
market_processing_frontier AS (
  SELECT block_number, timestamp_ms
  FROM active_market_frontier
  ORDER BY block_number, transaction_index, log_index
  LIMIT 1
),
market_cursor AS (
  SELECT legacy.coverage_start_at,
    CASE
      WHEN frontier.block_number IS NULL THEN head.checkpoint_timestamp
      WHEN frontier.timestamp_ms ~ '^[0-9]+$'
        THEN TO_TIMESTAMP(frontier.timestamp_ms::numeric / 1000)
      ELSE NULL
    END AS coverage_end_at,
    frontier.block_number IS NULL
      AND head.next_block > head.safe_head AS caught_up
  FROM legacy_market_coverage legacy
  LEFT JOIN market_head_cursor head ON TRUE
  LEFT JOIN market_processing_frontier frontier ON TRUE
)`;

module.exports = { MARKET_COVERAGE_CTES };
