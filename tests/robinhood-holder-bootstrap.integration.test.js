const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderBootstrapRepository,
} = require('../src/models/robinhood-holder-bootstrap');

const TOKENS = ['a', 'b', 'c', 'd', 'e'].map((digit) => `0x${digit.repeat(40)}`);

after(() => db.pool.end());

describe('Robinhood holder bootstrap persistence', () => {
  it('admits disjoint new/cold exact cohorts and remains idempotent', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE token_catalog (
        chain varchar(16) NOT NULL, address varchar(42) NOT NULL,
        first_seen_at timestamptz NOT NULL,
        PRIMARY KEY (chain, address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        source varchar(32) NOT NULL, attribution_block bigint,
        PRIMARY KEY (chain, token_address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states
        (LIKE public.robinhood_holder_token_states INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs
        (LIKE public.robinhood_holder_global_backfill_runs INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens
        (LIKE public.robinhood_holder_global_backfill_tokens INCLUDING ALL)`);
      await client.query(
        `INSERT INTO token_catalog VALUES
          ('robinhood', $1, '2026-08-10T00:01:00Z'),
          ('robinhood', $2, '2026-08-09T23:59:00Z'),
          ('robinhood', $3, '2026-08-10T00:02:00Z'),
          ('robinhood', $4, '2026-08-10T00:03:00Z'),
          ('robinhood', $5, '2026-08-10T00:04:00Z')`, TOKENS
      );
      await client.query(
        `INSERT INTO robinhood_token_attributions VALUES
          ('robinhood', $1, 'rpc_direct', 101),
          ('robinhood', $2, 'rpc_direct', 99),
          ('robinhood', $3, 'blockscout', NULL),
          ('robinhood', $4, 'launchpad_event', 104),
          ('robinhood', $5, 'rpc_direct', 105)`, TOKENS
      );
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 'backfilling', 104, 104)`, [TOKENS[3]]
      );
      const run = await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (catalog_cutoff)
         VALUES ('2026-08-10T00:05:00Z') RETURNING id`
      );
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens (run_id, token_address)
         VALUES ($1, $2)`, [run.rows[0].id, TOKENS[4]]
      );
      const database = { query: client.query.bind(client) };
      const repository = createRobinhoodHolderBootstrapRepository({ database });
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10,
      }), [{
        tokenAddress: TOKENS[0], deploymentBlock: '101',
        backfillNextBlock: '101', ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10,
      }), []);
      assert.deepEqual(await repository.seedColdTokens({
        admittedBefore: '2026-08-10T00:00:00Z', limit: 10,
      }), [{
        tokenAddress: TOKENS[1], deploymentBlock: '99',
        backfillNextBlock: '99', ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual(await repository.seedColdTokens({
        admittedBefore: '2026-08-10T00:00:00Z', limit: 10,
      }), []);
      const states = await client.query(
        `SELECT token_address, holder_count, ledger_status,
                deployment_block, backfill_next_block
           FROM robinhood_holder_token_states ORDER BY token_address`
      );
      assert.deepEqual(states.rows.map((row) => ({
        tokenAddress: row.token_address, holderCount: String(row.holder_count),
        ledgerStatus: row.ledger_status, deploymentBlock: String(row.deployment_block),
        backfillNextBlock: String(row.backfill_next_block),
      })), [{
        tokenAddress: TOKENS[0], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '101', backfillNextBlock: '101',
      }, {
        tokenAddress: TOKENS[1], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '99', backfillNextBlock: '99',
      }, {
        tokenAddress: TOKENS[3], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '104', backfillNextBlock: '104',
      }]);
    } finally {
      client.release();
    }
  });
});
