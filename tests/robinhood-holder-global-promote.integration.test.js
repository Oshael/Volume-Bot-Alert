const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  runGlobalHolderPromotion,
} = require('../src/utils/promote-robinhood-global-holder-cohort');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;
const TOKEN_C = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const ZERO = `0x${'0'.repeat(40)}`;

after(() => db.pool.end());

describe('Robinhood completed global holder cohort promotion', () => {
  it('dry-runs without writes and promotes only shadow tokens without pending journal', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs
        (LIKE public.robinhood_holder_global_backfill_runs INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens
        (LIKE public.robinhood_holder_global_backfill_tokens INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states
        (LIKE public.robinhood_holder_token_states INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal
        (LIKE public.robinhood_holder_transfer_journal INCLUDING ALL)`);
      const inserted = await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (
           status, catalog_cutoff, completed_at, cohort_token_count
         ) VALUES ('completed', NOW(), NOW(), 3) RETURNING id`
      );
      const runId = String(inserted.rows[0].id);
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens
           (run_id, token_address, status)
         VALUES ($1, $2, 'completed'), ($1, $3, 'completed'), ($1, $4, 'completed')`,
        [runId, TOKEN_A, TOKEN_B, TOKEN_C]
      );
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 'shadow', 1, 2), ($2, 'shadow', 1, 2), ($3, 'live', 1, 2)`,
        [TOKEN_A, TOKEN_B, TOKEN_C]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           token_address, block_number, block_hash, transaction_hash,
           transaction_index, log_index, from_wallet, to_wallet, amount_raw, applied
         ) VALUES ($1, 2, $2, $2, 0, 0, $3, $3, 0, false)`,
        [TOKEN_B, HASH, ZERO]
      );
      const database = {
        query: client.query.bind(client),
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };

      const preview = await runGlobalHolderPromotion({ database, runId });
      assert.equal(preview.mode, 'dry-run');
      assert.deepEqual(preview.before, {
        runId, runStatus: 'completed', cohortTokens: 3, completedCohortTokens: 3,
        shadowTokens: 2, eligibleTokens: 1, blockedPendingTokens: 1,
        pendingEvents: 1, liveTokens: 1,
      });
      const confirmed = await runGlobalHolderPromotion({
        database, runId, batchSize: 1, confirm: true,
      });
      assert.equal(confirmed.promotedTokens, 1);
      assert.equal(confirmed.batches, 1);
      assert.equal(confirmed.after.shadowTokens, 1);
      assert.equal(confirmed.after.blockedPendingTokens, 1);
      assert.equal(confirmed.after.liveTokens, 2);
      const states = await client.query(
        `SELECT token_address, ledger_status FROM robinhood_holder_token_states
          ORDER BY token_address`
      );
      assert.deepEqual(states.rows, [
        { token_address: TOKEN_A, ledger_status: 'live' },
        { token_address: TOKEN_B, ledger_status: 'shadow' },
        { token_address: TOKEN_C, ledger_status: 'live' },
      ]);
    } finally {
      client.release();
    }
  });
});
