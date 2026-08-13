require('dotenv').config();

const db = require('../models/db');

const CHAIN = 'robinhood';

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is required`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function summaryRow(row) {
  if (!row) return null;
  return Object.freeze({
    runId: String(row.id), runStatus: row.status,
    cohortTokens: Number(row.cohort_tokens), completedCohortTokens: Number(row.completed_tokens),
    shadowTokens: Number(row.shadow_tokens), eligibleTokens: Number(row.eligible_tokens),
    blockedPendingTokens: Number(row.blocked_pending_tokens),
    pendingEvents: Number(row.pending_events), liveTokens: Number(row.live_tokens),
  });
}

async function loadSummary(database, runId) {
  const result = await database.query(
    `SELECT run.id, run.status,
            COUNT(cohort.token_address)::int AS cohort_tokens,
            COUNT(*) FILTER (WHERE cohort.status = 'completed')::int AS completed_tokens,
            COUNT(*) FILTER (WHERE cohort.status = 'completed'
              AND state.ledger_status = 'shadow')::int AS shadow_tokens,
            COUNT(*) FILTER (WHERE cohort.status = 'completed'
              AND state.ledger_status = 'shadow' AND NOT EXISTS (
                SELECT 1 FROM robinhood_holder_transfer_journal journal
                 WHERE journal.chain = state.chain
                   AND journal.token_address = state.token_address
                   AND journal.applied = false
              ))::int AS eligible_tokens,
            COUNT(*) FILTER (WHERE cohort.status = 'completed'
              AND state.ledger_status = 'shadow' AND EXISTS (
                SELECT 1 FROM robinhood_holder_transfer_journal journal
                 WHERE journal.chain = state.chain
                   AND journal.token_address = state.token_address
                   AND journal.applied = false
              ))::int AS blocked_pending_tokens,
            COALESCE(SUM((SELECT COUNT(*)
              FROM robinhood_holder_transfer_journal journal
             WHERE journal.chain = state.chain AND journal.token_address = state.token_address
               AND journal.applied = false)) FILTER (WHERE cohort.status = 'completed'
                 AND state.ledger_status = 'shadow'), 0)::int AS pending_events,
            COUNT(*) FILTER (WHERE cohort.status = 'completed'
              AND state.ledger_status = 'live')::int AS live_tokens
       FROM robinhood_holder_global_backfill_runs run
       LEFT JOIN robinhood_holder_global_backfill_tokens cohort
         ON cohort.run_id = run.id AND cohort.chain = run.chain
       LEFT JOIN robinhood_holder_token_states state
         ON state.chain = cohort.chain AND state.token_address = cohort.token_address
      WHERE run.id = $1 AND run.chain = $2
      GROUP BY run.id, run.status`,
    [runId, CHAIN]
  );
  return summaryRow(result.rows[0]);
}

async function promoteBatch(database, runId, limit) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `SELECT status FROM robinhood_holder_global_backfill_runs
        WHERE id = $1 AND chain = $2 FOR UPDATE`, [runId, CHAIN]
    );
    if (run.rows[0]?.status !== 'completed') {
      const error = new Error('Robinhood holder global run must be completed');
      error.code = 'holder_global_promotion_run_not_completed';
      throw error;
    }
    const promoted = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT state.token_address
           FROM robinhood_holder_global_backfill_tokens cohort
           INNER JOIN robinhood_holder_token_states state
             ON state.chain = cohort.chain AND state.token_address = cohort.token_address
          WHERE cohort.run_id = $1 AND cohort.chain = $2 AND cohort.status = 'completed'
            AND state.ledger_status = 'shadow'
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_holder_transfer_journal journal
               WHERE journal.chain = state.chain AND journal.token_address = state.token_address
                 AND journal.applied = false
            )
          ORDER BY state.token_address LIMIT $3
          FOR UPDATE OF state SKIP LOCKED
       )
       UPDATE robinhood_holder_token_states state
          SET ledger_status = 'live', version = version + 1, updated_at = NOW()
         FROM candidates
        WHERE state.chain = $2 AND state.token_address = candidates.token_address
          AND state.ledger_status = 'shadow'
          AND NOT EXISTS (
            SELECT 1 FROM robinhood_holder_transfer_journal journal
             WHERE journal.chain = state.chain AND journal.token_address = state.token_address
               AND journal.applied = false
          )
       RETURNING state.token_address`,
      [runId, CHAIN, limit]
    );
    await client.query('COMMIT');
    return promoted.rowCount;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runGlobalHolderPromotion(input = {}) {
  const database = input.database || db;
  const runId = positiveInteger(input.runId, 'ROBINHOOD_HOLDER_GLOBAL_PROMOTE_RUN_ID');
  const batchSize = positiveInteger(input.batchSize ?? 5000, 'batchSize', 5000);
  const before = await loadSummary(database, runId);
  if (!before) throw new Error(`Robinhood holder global run ${runId} was not found`);
  if (before.runStatus !== 'completed') {
    throw new Error(`Robinhood holder global run ${runId} is not completed`);
  }
  if (input.confirm !== true) return Object.freeze({ mode: 'dry-run', before });
  let promotedTokens = 0;
  let batches = 0;
  while (true) {
    const promoted = await promoteBatch(database, runId, batchSize);
    if (!promoted) break;
    promotedTokens += promoted;
    batches += 1;
  }
  return Object.freeze({
    mode: 'confirmed', promotedTokens, batches, before,
    after: await loadSummary(database, runId),
  });
}

async function main() {
  try {
    console.log(JSON.stringify(await runGlobalHolderPromotion({
      runId: process.env.ROBINHOOD_HOLDER_GLOBAL_PROMOTE_RUN_ID,
      batchSize: process.env.ROBINHOOD_HOLDER_GLOBAL_PROMOTE_BATCH_SIZE,
      confirm: process.argv.includes('--confirm-promote'),
    }), null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodGlobalHolderPromotion] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = { runGlobalHolderPromotion, __private: { loadSummary, promoteBatch } };
