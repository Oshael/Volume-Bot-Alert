'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const CONFIRM_FLAG = '--confirm-reconcile-archive-funding';
const MAX_LIMIT = 1_000;

const REPAIRABLE_CTE = `WITH archive_queue AS (
  SELECT queue.chain, queue.token_address, queue.requested_version,
         queue.anchor_block, queue.source_through_block, queue.lookback_blocks,
         queue.rule_version, queue.evidence_version
    FROM robinhood_bundle_funding_live_queue queue
   WHERE queue.chain = $1 AND queue.status = 'complete'
     AND queue.last_error_code = 'archive_required'
), assessed AS (
  SELECT queue.*,
    CASE WHEN EXISTS (
      SELECT 1 FROM robinhood_possible_bundle_states state
       WHERE state.chain = queue.chain AND state.token_address = queue.token_address
         AND state.rule_version = queue.rule_version AND state.status = 'ready'
         AND state.evidence_version = queue.evidence_version
         AND state.lookback_blocks = queue.lookback_blocks
         AND state.through_block_number >= queue.source_through_block
         AND ((state.source_kind = 'live'
               AND state.source_version >= queue.requested_version)
           OR (state.source_kind = 'seed' AND EXISTS (
             SELECT 1 FROM robinhood_bundle_funding_backfill_runs run
              WHERE run.chain = queue.chain AND run.id = state.source_run_id
                AND run.status = 'completed'
                AND run.rule_version = queue.rule_version
                AND run.evidence_version = queue.evidence_version
                AND run.lookback_blocks = queue.lookback_blocks
                AND run.source_through_block = state.through_block_number
                AND run.source_through_hash = state.through_block_hash
                AND EXISTS (
                  SELECT 1 FROM robinhood_bundle_funding_backfill_candidates candidate
                   WHERE candidate.run_id = run.id
                     AND candidate.token_address = queue.token_address
                     AND candidate.launch_block = queue.anchor_block
                )
                AND NOT EXISTS (
                  SELECT 1 FROM robinhood_bundle_funding_backfill_candidates candidate
                   WHERE candidate.run_id = run.id
                     AND candidate.token_address = queue.token_address
                     AND candidate.launch_block <> queue.anchor_block
                )
           )))
    ) THEN 'durable_snapshot'
    WHEN EXISTS (
      SELECT 1 FROM robinhood_holder_token_states holder
       WHERE holder.chain = queue.chain AND holder.token_address = queue.token_address
         AND holder.ledger_status = 'live'
         AND holder.live_through_block >= queue.source_through_block
    ) AND EXISTS (
      SELECT 1 FROM robinhood_first_buy_live_cursors cursor
      INNER JOIN robinhood_first_buy_backfill_runs seed
        ON seed.chain = cursor.chain AND seed.id = cursor.seed_run_id
       WHERE cursor.chain = queue.chain AND seed.status = 'completed'
         AND cursor.source_next_block > queue.source_through_block
    ) AND 2 > (
      SELECT COUNT(*) FROM (
        SELECT 1 FROM robinhood_wallet_token_first_buys buy
         WHERE buy.chain = queue.chain AND buy.token_address = queue.token_address
           AND buy.block_number BETWEEN queue.anchor_block AND queue.anchor_block + 3
           AND buy.block_number <= queue.source_through_block
           AND buy.wallet_address NOT IN (
             '0x0000000000000000000000000000000000000000',
             '0x000000000000000000000000000000000000dead'
           )
           AND NOT EXISTS (
             SELECT 1 FROM robinhood_infrastructure_registry infrastructure
              WHERE infrastructure.chain = buy.chain
                AND infrastructure.address = buy.wallet_address
                AND infrastructure.valid_from_block <= buy.block_number
                AND (infrastructure.valid_through_block IS NULL
                  OR infrastructure.valid_through_block >= buy.block_number)
           )
           AND NOT EXISTS (
             SELECT 1 FROM robinhood_pool_registry pool
              WHERE pool.chain = buy.chain AND pool.token_address = buy.token_address
                AND pool.discovery_block <= buy.block_number
                AND CASE WHEN pool.protocol = 'uniswap-v4'
                  THEN pool.origin_address ELSE pool.pool_address END = buy.wallet_address
           )
         LIMIT 2
      ) eligible
    ) THEN 'insufficient_candidates' END AS repair_reason
  FROM archive_queue queue
), selected AS MATERIALIZED (
  SELECT * FROM assessed WHERE repair_reason IS NOT NULL
   ORDER BY token_address LIMIT $2::int
)`;

const INSPECT_SQL = `${REPAIRABLE_CTE}
SELECT token_address, requested_version::text, repair_reason
  FROM selected ORDER BY token_address`;

const APPLY_SQL = `${REPAIRABLE_CTE}
UPDATE robinhood_bundle_funding_live_queue queue SET
  last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
FROM selected
WHERE queue.chain = selected.chain AND queue.token_address = selected.token_address
  AND queue.status = 'complete' AND queue.last_error_code = 'archive_required'
  AND queue.requested_version = selected.requested_version
RETURNING queue.token_address, queue.requested_version::text, selected.repair_reason`;

const COUNT_SQL = `SELECT COUNT(*)::int AS remaining
  FROM robinhood_bundle_funding_live_queue
 WHERE chain = $1 AND status = 'complete' AND last_error_code = 'archive_required'`;

function limit(value) {
  const parsed = Number(value ?? 100);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function report(rows, remaining, mode) {
  const repaired = Object.fromEntries(['durable_snapshot', 'insufficient_candidates']
    .map((reason) => [reason, rows.filter((row) => row.repair_reason === reason).length]));
  return Object.freeze({ mode, candidates: rows.length, repaired,
    remainingArchiveRequired: Number(remaining), tokens: Object.freeze(rows.map((row) => ({
      tokenAddress: row.token_address, requestedVersion: row.requested_version,
      reason: row.repair_reason,
    }))) });
}

function createRobinhoodBundleFundingArchiveReconciliation(options = {}) {
  const database = options.database || db;
  async function run(input = {}) {
    const apply = input.apply === true;
    const rows = (await database.query(apply ? APPLY_SQL : INSPECT_SQL, [
      CHAIN, limit(input.limit),
    ])).rows;
    const remaining = (await database.query(COUNT_SQL, [CHAIN])).rows[0]?.remaining || 0;
    return report(rows, remaining, apply ? 'apply' : 'read-only');
  }
  return Object.freeze({ run });
}

module.exports = {
  APPLY_SQL, CONFIRM_FLAG, COUNT_SQL, INSPECT_SQL, MAX_LIMIT,
  createRobinhoodBundleFundingArchiveReconciliation,
};
