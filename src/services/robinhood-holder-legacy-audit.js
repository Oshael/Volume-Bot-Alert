'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const SAMPLE_LIMIT = 4;

const FRONTIER_SQL = `SELECT cursor.next_block, cursor.checkpoint_block,
    cursor.checkpoint_hash, cursor.journal_floor_block,
    capture.checkpoint_block AS capture_checkpoint_block,
    (SELECT MIN(block_number) FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical=TRUE) AS raw_floor_block
  FROM robinhood_holder_cursors cursor
  LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=cursor.chain
 WHERE cursor.chain=$1 AND cursor.stream='live'`;

const STATES_SQL = `SELECT ledger_status,
    CASE WHEN tail_capture_from_block IS NULL THEN 'legacy_null' ELSE 'tail_present' END
      AS coverage,
    COUNT(*)::bigint AS total,
    COUNT(*) FILTER (WHERE deployment_block IS NULL)::bigint AS missing_deployment,
    COUNT(*) FILTER (WHERE backfill_next_block IS NULL)::bigint AS missing_backfill_cursor,
    COUNT(*) FILTER (WHERE backfill_next_block < deployment_block)::bigint
      AS backfill_before_deployment,
    COUNT(*) FILTER (WHERE live_through_block IS NULL OR live_through_hash IS NULL)::bigint
      AS missing_live_checkpoint,
    COUNT(*) FILTER (WHERE live_through_block > $2::bigint)::bigint
      AS ahead_of_holder_checkpoint,
    COUNT(*) FILTER (WHERE ledger_status IN ('shadow','live')
      AND live_through_block < deployment_block)::bigint AS live_before_deployment,
    MIN(backfill_next_block) AS oldest_backfill_cursor,
    MAX(backfill_next_block) AS newest_backfill_cursor
  FROM robinhood_holder_token_states
 WHERE chain=$1 AND ledger_status IN ('backfilling','shadow','live','drifted','resyncing')
 GROUP BY ledger_status, coverage ORDER BY ledger_status, coverage`;

const BACKFILLING_SQL = `SELECT state.token_address, state.ledger_status,
    state.deployment_block, state.backfill_next_block, state.live_through_block,
    state.live_through_hash, state.holder_count,
    block.canonical AS checkpoint_canonical,
    (SELECT journal.block_number FROM robinhood_holder_transfer_journal journal
      WHERE journal.chain=$1 AND journal.token_address=state.token_address
        AND journal.applied=FALSE
      ORDER BY journal.block_number, journal.transaction_index, journal.log_index
      LIMIT 1) AS oldest_pending_block,
    EXISTS (SELECT 1 FROM robinhood_holder_transfer_journal journal
      WHERE journal.chain=$1 AND journal.token_address=state.token_address
        AND journal.applied=TRUE
        AND journal.block_number < state.backfill_next_block) AS applied_overlap
  FROM robinhood_holder_token_states state
  LEFT JOIN robinhood_chain_blocks block
    ON block.chain=state.chain AND block.block_number=state.live_through_block
   AND block.block_hash=state.live_through_hash
 WHERE state.chain=$1 AND state.ledger_status='backfilling'
   AND state.tail_capture_from_block IS NULL
 ORDER BY state.backfill_next_block DESC NULLS LAST, state.token_address LIMIT $2`;

const SHADOW_WITHOUT_CHECKPOINT_SQL = `SELECT COUNT(*)::bigint AS total,
    COUNT(*) FILTER (WHERE pending.present IS NOT NULL)::bigint AS with_pending,
    COUNT(*) FILTER (WHERE pending.present IS NULL)::bigint AS without_pending,
    COUNT(*) FILTER (WHERE state.holder_count <> 0)::bigint AS nonzero_holders,
    COUNT(*) FILTER (WHERE pending.present IS NULL
      AND state.deployment_block < cursor.next_block)::bigint AS promotable_by_current_sql
  FROM robinhood_holder_token_states state
  JOIN robinhood_holder_cursors cursor
    ON cursor.chain=state.chain AND cursor.stream='live'
  LEFT JOIN LATERAL (
    SELECT 1 AS present FROM robinhood_holder_transfer_journal journal
     WHERE journal.chain=state.chain AND journal.token_address=state.token_address
       AND journal.applied=FALSE LIMIT 1
  ) pending ON TRUE
 WHERE state.chain=$1 AND state.ledger_status='shadow'
   AND state.tail_capture_from_block IS NULL AND state.live_through_block IS NULL`;

const COHORT_SQL = `SELECT COUNT(*)::bigint AS active_tokens,
    COUNT(*) FILTER (WHERE run.barrier_block IS NULL)::bigint AS missing_barrier,
    COUNT(*) FILTER (WHERE state.token_address IS NULL)::bigint AS without_state,
    COUNT(*) FILTER (WHERE state.token_address IS NOT NULL)::bigint AS state_overlap
  FROM robinhood_holder_global_backfill_tokens token
  JOIN robinhood_holder_global_backfill_runs run
    ON run.id=token.run_id AND run.chain=token.chain
  LEFT JOIN robinhood_holder_token_states state
    ON state.chain=token.chain AND state.token_address=token.token_address
 WHERE token.chain=$1 AND token.status='active' AND run.status<>'completed'`;

const SAMPLES_SQL = `WITH sample AS (
    (SELECT token_address, ledger_status, deployment_block, backfill_next_block,
            live_through_block, live_through_hash, holder_count
       FROM robinhood_holder_token_states
      WHERE chain=$1 AND ledger_status='live' AND tail_capture_from_block IS NULL
      ORDER BY backfill_next_block DESC NULLS LAST, token_address LIMIT $2)
    UNION ALL
    (SELECT token_address, ledger_status, deployment_block, backfill_next_block,
            live_through_block, live_through_hash, holder_count
       FROM robinhood_holder_token_states
      WHERE chain=$1 AND ledger_status='shadow' AND tail_capture_from_block IS NULL
      ORDER BY backfill_next_block DESC NULLS LAST, token_address LIMIT $2)
  )
  SELECT sample.*, block.canonical AS checkpoint_canonical,
    CASE WHEN sample.live_through_block IS NULL THEN NULL ELSE
      EXISTS (SELECT 1 FROM robinhood_holder_transfer_journal journal
        WHERE journal.chain=$1 AND journal.token_address=sample.token_address
          AND journal.applied=FALSE
          AND journal.block_number <= sample.live_through_block)
    END AS pending_at_or_before_state,
    EXISTS (SELECT 1 FROM robinhood_holder_transfer_journal journal
      WHERE journal.chain=$1 AND journal.token_address=sample.token_address
        AND journal.applied=FALSE) AS pending_anywhere
  FROM sample LEFT JOIN robinhood_chain_blocks block
    ON block.chain=$1 AND block.block_number=sample.live_through_block
   AND block.block_hash=sample.live_through_hash
  ORDER BY sample.ledger_status, sample.token_address`;

function numberOrNull(value) {
  return value == null ? null : String(value);
}

function stateGroup(row) {
  return {
    status: row.ledger_status, coverage: row.coverage,
    total: Number(row.total), missingDeployment: Number(row.missing_deployment),
    missingBackfillCursor: Number(row.missing_backfill_cursor),
    backfillBeforeDeployment: Number(row.backfill_before_deployment),
    missingLiveCheckpoint: Number(row.missing_live_checkpoint),
    aheadOfHolderCheckpoint: Number(row.ahead_of_holder_checkpoint),
    liveBeforeDeployment: Number(row.live_before_deployment),
    oldestBackfillCursor: numberOrNull(row.oldest_backfill_cursor),
    newestBackfillCursor: numberOrNull(row.newest_backfill_cursor),
  };
}

function tokenRow(row) {
  return {
    tokenAddress: row.token_address, status: row.ledger_status,
    deploymentBlock: numberOrNull(row.deployment_block),
    backfillNextBlock: numberOrNull(row.backfill_next_block),
    liveThroughBlock: numberOrNull(row.live_through_block),
    liveThroughHash: row.live_through_hash,
    holderCount: numberOrNull(row.holder_count),
    ...(row.checkpoint_canonical === undefined ? {} : {
      checkpointCanonical: row.checkpoint_canonical,
    }),
    ...(row.pending_at_or_before_state === undefined ? {} : {
      pendingAtOrBeforeState: row.pending_at_or_before_state,
    }),
    ...(row.pending_anywhere === undefined ? {} : { pendingAnywhere: row.pending_anywhere }),
    ...(row.oldest_pending_block === undefined ? {} : {
      oldestPendingBlock: numberOrNull(row.oldest_pending_block),
    }),
    ...(row.applied_overlap === undefined ? {} : { appliedOverlap: row.applied_overlap }),
  };
}

function createRobinhoodHolderLegacyAudit(options = {}) {
  const database = options.database || db;
  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      const frontier = (await client.query(FRONTIER_SQL, [CHAIN])).rows[0];
      if (!frontier) throw new Error('Robinhood holder live cursor is missing');
      const states = await client.query(STATES_SQL, [CHAIN, frontier.checkpoint_block]);
      const backfilling = await client.query(BACKFILLING_SQL, [CHAIN, SAMPLE_LIMIT + 1]);
      const shadowWithoutCheckpoint = await client.query(SHADOW_WITHOUT_CHECKPOINT_SQL, [CHAIN]);
      const cohorts = await client.query(COHORT_SQL, [CHAIN]);
      const samples = await client.query(SAMPLES_SQL, [CHAIN, SAMPLE_LIMIT]);
      await client.query('ROLLBACK');
      const cohort = cohorts.rows[0];
      return Object.freeze({
        mode: 'read-only', sampleLimitPerStatus: SAMPLE_LIMIT,
        snapshot: {
          nextBlock: numberOrNull(frontier.next_block),
          holderCheckpointBlock: numberOrNull(frontier.checkpoint_block),
          holderCheckpointHash: frontier.checkpoint_hash,
          captureCheckpointBlock: numberOrNull(frontier.capture_checkpoint_block),
          journalFloorBlock: numberOrNull(frontier.journal_floor_block),
          rawFloorBlock: numberOrNull(frontier.raw_floor_block),
        },
        stateGroups: states.rows.map(stateGroup),
        legacyBackfilling: backfilling.rows.slice(0, SAMPLE_LIMIT).map(tokenRow),
        legacyBackfillingTruncated: backfilling.rows.length > SAMPLE_LIMIT,
        legacyShadowWithoutCheckpoint: {
          total: Number(shadowWithoutCheckpoint.rows[0].total),
          withPending: Number(shadowWithoutCheckpoint.rows[0].with_pending),
          withoutPending: Number(shadowWithoutCheckpoint.rows[0].without_pending),
          nonzeroHolders: Number(shadowWithoutCheckpoint.rows[0].nonzero_holders),
          promotableByCurrentSql: Number(shadowWithoutCheckpoint.rows[0].promotable_by_current_sql),
        },
        globalCohort: {
          activeTokens: Number(cohort.active_tokens),
          missingBarrier: Number(cohort.missing_barrier),
          withoutState: Number(cohort.without_state),
          stateOverlap: Number(cohort.state_overlap),
        },
        legacyPromotedSamples: samples.rows.map(tokenRow),
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = { createRobinhoodHolderLegacyAudit };
