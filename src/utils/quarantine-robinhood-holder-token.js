require('dotenv').config();

const db = require('../models/db');

const WRITER_LEASE_KEYS = Object.freeze([
  'robinhood-holder-live-worker',
  'robinhood-holder-backfill-worker',
  'robinhood-holder-cold-worker',
  'robinhood-holder-global-backfill-worker',
]);

function tokenAddress(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error('ROBINHOOD_HOLDER_QUARANTINE_TOKEN is required');
  }
  return token;
}

function candidateRow(row) {
  if (!row) return null;
  const appliedEvents = Number(row.applied_events) || 0;
  const activeCampaigns = Number(row.active_campaigns) || 0;
  const activeCampaignStatus = row.active_campaign_status || null;
  let ineligibleReason = null;
  if (row.ledger_status !== 'backfilling') ineligibleReason = 'not_backfilling';
  else if (row.deployment_block == null || row.backfill_next_block == null) {
    ineligibleReason = 'missing_backfill_cursor';
  } else if (appliedEvents > 0) ineligibleReason = 'applied_journal_exists';
  else if (activeCampaigns > 1
    || activeCampaignStatus && !['scanning', 'attached'].includes(activeCampaignStatus)) {
    ineligibleReason = 'unsupported_active_campaign';
  }
  return Object.freeze({
    tokenAddress: row.token_address,
    ledgerStatus: row.ledger_status,
    deploymentBlock: row.deployment_block == null ? null : String(row.deployment_block),
    backfillNextBlock: row.backfill_next_block == null
      ? null : String(row.backfill_next_block),
    liveThroughBlock: row.live_through_block == null ? null : String(row.live_through_block),
    version: String(row.version), holderCount: String(row.holder_count),
    balanceRows: Number(row.balance_rows) || 0,
    pendingEvents: Number(row.pending_events) || 0,
    appliedEvents, activeCampaigns, activeCampaignStatus,
    oldestPendingBlock: row.oldest_pending_block == null
      ? null : String(row.oldest_pending_block),
    newestPendingBlock: row.newest_pending_block == null
      ? null : String(row.newest_pending_block),
    eligible: ineligibleReason === null, ineligibleReason,
  });
}

async function loadCandidate(database, token) {
  const result = await database.query(
    `SELECT state.*,
            (SELECT COUNT(*) FROM robinhood_holder_balances balance
              WHERE balance.chain = state.chain
                AND balance.token_address = state.token_address)::int AS balance_rows,
            (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = state.chain AND journal.token_address = state.token_address
                AND journal.applied = false)::int AS pending_events,
            (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = state.chain AND journal.token_address = state.token_address
                AND journal.applied = true)::int AS applied_events,
            (SELECT MIN(block_number) FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = state.chain AND journal.token_address = state.token_address
                AND journal.applied = false) AS oldest_pending_block,
            (SELECT MAX(block_number) FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = state.chain AND journal.token_address = state.token_address
                AND journal.applied = false) AS newest_pending_block,
            (SELECT COUNT(*) FROM robinhood_holder_global_backfill_tokens cohort
              INNER JOIN robinhood_holder_global_backfill_runs run
                ON run.id = cohort.run_id AND run.chain = cohort.chain
              WHERE cohort.chain = state.chain AND cohort.token_address = state.token_address
                AND cohort.status = 'active' AND run.status <> 'completed')::int
              AS active_campaigns,
            (SELECT MIN(run.status) FROM robinhood_holder_global_backfill_tokens cohort
              INNER JOIN robinhood_holder_global_backfill_runs run
                ON run.id = cohort.run_id AND run.chain = cohort.chain
              WHERE cohort.chain = state.chain AND cohort.token_address = state.token_address
                AND cohort.status = 'active' AND run.status <> 'completed')
              AS active_campaign_status
       FROM robinhood_holder_token_states state
      WHERE state.chain = 'robinhood' AND state.token_address = $1`,
    [token]
  );
  return candidateRow(result.rows[0]);
}

async function assertWritersStopped(client) {
  const result = await client.query(
    `SELECT lease_key FROM worker_leases
      WHERE lease_key = ANY($1::varchar[]) AND lease_until > NOW()
      ORDER BY lease_key`,
    [[...WRITER_LEASE_KEYS]]
  );
  if (result.rowCount) {
    const error = new Error(`holder writers must be stopped: ${
      result.rows.map((row) => row.lease_key).join(', ')}`);
    error.code = 'holder_quarantine_writer_active';
    throw error;
  }
}

async function quarantineCandidate(database, candidate) {
  if (!candidate?.eligible) return null;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await assertWritersStopped(client);
    const locked = await client.query(
      `SELECT token_address FROM robinhood_holder_token_states
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'backfilling' AND version = $2::bigint
          AND deployment_block = $3::bigint AND backfill_next_block = $4::bigint
        FOR UPDATE`,
      [candidate.tokenAddress, candidate.version,
        candidate.deploymentBlock, candidate.backfillNextBlock]
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    const applied = await client.query(
      `SELECT COUNT(*)::int AS applied_events
         FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND token_address = $1 AND applied = true`,
      [candidate.tokenAddress]
    );
    const campaigns = await client.query(
      `SELECT cohort.run_id, run.status
         FROM robinhood_holder_global_backfill_tokens cohort
         INNER JOIN robinhood_holder_global_backfill_runs run
           ON run.id = cohort.run_id AND run.chain = cohort.chain
        WHERE cohort.chain = 'robinhood' AND cohort.token_address = $1
          AND cohort.status = 'active' AND run.status <> 'completed'
        FOR UPDATE OF cohort, run`, [candidate.tokenAddress]
    );
    if (Number(applied.rows[0]?.applied_events) > 0 || campaigns.rowCount > 1
      || campaigns.rows.some((row) => !['scanning', 'attached'].includes(row.status))) {
      await client.query('ROLLBACK');
      return null;
    }
    const balances = await client.query(
      `DELETE FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1`, [candidate.tokenAddress]
    );
    const journal = await client.query(
      `DELETE FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND token_address = $1`, [candidate.tokenAddress]
    );
    const excluded = await client.query(
      `UPDATE robinhood_holder_global_backfill_tokens
          SET holder_count = 0, status = 'excluded',
              exclusion_reason = 'operator_quarantine_pathological_volume',
              updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1 AND status = 'active'
          AND run_id = ANY($2::bigint[])`,
      [candidate.tokenAddress, campaigns.rows.map((row) => row.run_id)]
    );
    const state = await client.query(
      `UPDATE robinhood_holder_token_states
          SET holder_count = 0, ledger_status = 'drifted',
              backfill_next_block = deployment_block,
              live_through_block = NULL, live_through_hash = NULL,
              last_reconciled_at = NULL, version = version + 1, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1 AND version = $2::bigint
        RETURNING deployment_block, version`,
      [candidate.tokenAddress, candidate.version]
    );
    if (!state.rowCount) throw new Error('holder quarantine lost its state lock');
    await client.query('COMMIT');
    return Object.freeze({
      tokenAddress: candidate.tokenAddress, ledgerStatus: 'drifted',
      restartBlock: String(state.rows[0].deployment_block),
      version: String(state.rows[0].version),
      deletedBalances: balances.rowCount, deletedJournalEvents: journal.rowCount,
      excludedCampaignTokens: excluded.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runHolderQuarantine(input = {}) {
  const database = input.database || db;
  const token = tokenAddress(input.tokenAddress);
  const candidate = await loadCandidate(database, token);
  if (input.confirm !== true) return Object.freeze({ mode: 'dry-run', candidate });
  const quarantined = await quarantineCandidate(database, candidate);
  return Object.freeze({
    mode: 'confirmed', candidate, quarantined,
    stale: candidate?.eligible === true && quarantined === null,
  });
}

async function main() {
  try {
    console.log(JSON.stringify(await runHolderQuarantine({
      tokenAddress: process.env.ROBINHOOD_HOLDER_QUARANTINE_TOKEN,
      confirm: process.argv.includes('--confirm-quarantine'),
    }), null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodHolderQuarantine] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = {
  runHolderQuarantine,
  __private: { loadCandidate, quarantineCandidate },
};
