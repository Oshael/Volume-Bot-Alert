require('dotenv').config();

const db = require('../models/db');

function boundedLimit(value) {
  const parsed = value == null || value === '' ? 100 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error('repair limit must be between 1 and 1000');
  }
  return parsed;
}

function candidateRow(row) {
  return Object.freeze({
    tokenAddress: row.token_address,
    deploymentBlock: String(row.deployment_block),
    backfillNextBlock: String(row.backfill_next_block),
    liveThroughBlock: String(row.live_through_block),
    liveThroughHash: row.live_through_hash,
    version: String(row.version),
    balanceRows: Number(row.balance_rows) || 0,
    journalEvents: Number(row.journal_events) || 0,
  });
}

async function loadCandidates(database, limit) {
  const result = await database.query(
    `SELECT state.token_address, state.deployment_block, state.backfill_next_block,
            state.live_through_block, state.live_through_hash, state.version,
            (SELECT COUNT(*) FROM robinhood_holder_balances balances
              WHERE balances.chain = state.chain
                AND balances.token_address = state.token_address)::int AS balance_rows,
            (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
              WHERE journal.chain = state.chain
                AND journal.token_address = state.token_address)::int AS journal_events
       FROM robinhood_holder_token_states state
      WHERE state.chain = 'robinhood' AND state.ledger_status = 'backfilling'
        AND state.deployment_block IS NOT NULL AND state.backfill_next_block IS NOT NULL
        AND state.live_through_block IS NOT NULL
        AND state.live_through_block + 1 <> state.backfill_next_block
      ORDER BY state.backfill_next_block DESC, state.token_address
      LIMIT $1::int`,
    [limit]
  );
  return result.rows.map(candidateRow);
}

async function resetCandidate(database, candidate) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT token_address FROM robinhood_holder_token_states
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'backfilling' AND version = $2::bigint
          AND backfill_next_block = $3::bigint
          AND live_through_block = $4::bigint AND live_through_hash = $5
          AND live_through_block + 1 <> backfill_next_block
        FOR UPDATE`,
      [candidate.tokenAddress, candidate.version, candidate.backfillNextBlock,
        candidate.liveThroughBlock, candidate.liveThroughHash]
    );
    if (!locked.rowCount) {
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
    const state = await client.query(
      `UPDATE robinhood_holder_token_states
          SET holder_count = 0, backfill_next_block = deployment_block,
              live_through_block = NULL, live_through_hash = NULL,
              version = version + 1, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1 AND version = $2::bigint
        RETURNING deployment_block, version`, [candidate.tokenAddress, candidate.version]
    );
    if (!state.rowCount) throw new Error('holder checkpoint repair lost its state lock');
    await client.query('COMMIT');
    return Object.freeze({
      tokenAddress: candidate.tokenAddress,
      restartBlock: String(state.rows[0].deployment_block),
      version: String(state.rows[0].version),
      deletedBalances: balances.rowCount,
      deletedJournalEvents: journal.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runCheckpointRepair(input = {}) {
  const database = input.database || db;
  const candidates = await loadCandidates(database, boundedLimit(input.limit));
  if (input.confirm !== true) {
    return Object.freeze({ mode: 'dry-run', candidates: Object.freeze(candidates) });
  }
  const repaired = [];
  const staleTokens = [];
  for (const candidate of candidates) {
    const result = await resetCandidate(database, candidate);
    if (result) repaired.push(result);
    else staleTokens.push(candidate.tokenAddress);
  }
  return Object.freeze({
    mode: 'confirmed', candidates: Object.freeze(candidates),
    repaired: Object.freeze(repaired), staleTokens: Object.freeze(staleTokens),
  });
}

async function main() {
  try {
    const result = await runCheckpointRepair({
      confirm: process.argv.includes('--confirm-reset'),
      limit: process.env.ROBINHOOD_HOLDER_CHECKPOINT_REPAIR_LIMIT,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodHolderCheckpointRepair] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = { runCheckpointRepair, __private: { loadCandidates, resetCandidate } };
