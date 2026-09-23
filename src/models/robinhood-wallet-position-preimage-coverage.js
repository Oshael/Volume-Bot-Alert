'use strict';

// A rewind cannot cross finalized_head. Every LIVE position batch above that
// boundary must have a canonical marker, including batches without positions.
const PREIMAGE_COVERAGE_SQL = `WITH state AS (
  SELECT capture.chain, capture.finalized_head, capture.recovery_state,
         position.projection_version, position.lifecycle_state,
         position.next_block, position.checkpoint_block, position.checkpoint_hash
    FROM robinhood_chain_capture_cursor capture
    JOIN robinhood_wallet_position_cursors position
      ON position.chain=capture.chain AND position.stream='live'
     AND position.projection_version='unified_transfer_v1'
   WHERE capture.chain=$1
), ordered AS (
  SELECT marker.from_block, marker.through_block,
         MAX(marker.through_block) OVER (
           ORDER BY marker.through_block, marker.from_block
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS previous_through
    FROM state
    JOIN robinhood_wallet_position_reorg_preimages marker
      ON marker.chain=state.chain
     AND marker.projection_version=state.projection_version
     AND marker.record_kind='batch' AND marker.identity_key='batch'
     AND marker.through_block > state.finalized_head
     AND marker.through_block <= state.checkpoint_block
    JOIN robinhood_chain_blocks block ON block.chain=marker.chain
     AND block.block_number=marker.through_block
     AND block.block_hash=marker.checkpoint_hash AND block.canonical
), coverage AS (
  SELECT MIN(from_block) AS first_from, MAX(through_block) AS last_through,
         COUNT(*) FILTER (WHERE previous_through IS NOT NULL
           AND from_block > previous_through + 1) AS gaps
    FROM ordered
)
SELECT NOT COALESCE((
  SELECT state.recovery_state='running'
     AND state.finalized_head IS NOT NULL
     AND state.lifecycle_state='running'
     AND state.next_block=state.checkpoint_block + 1
     AND EXISTS (
       SELECT 1 FROM robinhood_wallet_position_reorg_preimages marker
       JOIN robinhood_chain_blocks block ON block.chain=marker.chain
        AND block.block_number=marker.through_block
        AND block.block_hash=marker.checkpoint_hash AND block.canonical
       WHERE marker.chain=state.chain
         AND marker.projection_version=state.projection_version
         AND marker.record_kind='batch' AND marker.identity_key='batch'
         AND marker.through_block=state.checkpoint_block
         AND marker.checkpoint_hash=state.checkpoint_hash
     )
     AND (state.checkpoint_block <= state.finalized_head OR (
       coverage.first_from <= state.finalized_head + 1
       AND coverage.last_through=state.checkpoint_block
       AND coverage.gaps=0
     ))
    FROM state CROSS JOIN coverage
), false) AS present`;

module.exports = { PREIMAGE_COVERAGE_SQL };
