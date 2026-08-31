const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderGlobalBackfillRepository,
} = require('../src/models/robinhood-holder-global-backfill');

const TOKENS = ['a', 'b', 'c', 'd'].map((digit) => `0x${digit.repeat(40)}`);

after(() => db.pool.end());

describe('Robinhood holder global backfill lifecycle', () => {
  it('atomically freezes the old stateless catalog cohort and starts it with CAS', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE token_catalog (
        chain varchar(16) NOT NULL, address varchar(42) NOT NULL,
        first_seen_at timestamptz NOT NULL, PRIMARY KEY (chain, address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        PRIMARY KEY (chain, token_address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        source varchar(32) NOT NULL, attribution_block bigint,
        PRIMARY KEY (chain, token_address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs
        (LIKE public.robinhood_holder_global_backfill_runs INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens
        (LIKE public.robinhood_holder_global_backfill_tokens INCLUDING ALL)`);
      await client.query(
        `INSERT INTO token_catalog VALUES
          ('robinhood', $1, '2026-08-09T00:00:00Z'),
          ('robinhood', $2, '2026-08-09T01:00:00Z'),
          ('robinhood', $3, '2026-08-11T00:00:00Z'),
          ('solana', $4, '2026-08-09T00:00:00Z')`, TOKENS
      );
      await client.query(
        `INSERT INTO robinhood_holder_token_states VALUES ('robinhood', $1)`, [TOKENS[1]]
      );
      await client.query(
        `INSERT INTO robinhood_token_attributions VALUES
          ('robinhood', $1, 'rpc_code_transition', 100)`, [TOKENS[0]]
      );
      const database = {
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
        query: client.query.bind(client),
      };
      const repository = createRobinhoodHolderGlobalBackfillRepository({ database });
      const frozen = await repository.createRun({ catalogCutoff: '2026-08-10T00:00:00Z' });
      assert.equal(frozen.status, 'frozen');
      assert.equal(frozen.nextBlock, '0');
      assert.equal(frozen.cohortTokenCount, '1');
      assert.deepEqual(await repository.loadCohort({ runId: frozen.id }), [TOKENS[0]]);
      assert.deepEqual(await repository.loadCohortSchedule({ runId: frozen.id }), [{
        tokenAddress: TOKENS[0], deploymentBlock: '100',
      }]);
      assert.deepEqual(await repository.getActiveRun(), frozen);

      await assert.rejects(
        repository.createRun({ catalogCutoff: '2026-08-10T00:00:00Z' }),
        { code: 'holder_global_backfill_active_run_exists' }
      );
      const scanning = await repository.startRun({ runId: frozen.id, version: frozen.version });
      assert.equal(scanning.status, 'scanning');
      assert.equal(scanning.version, '1');
      await assert.rejects(
        repository.startRun({ runId: frozen.id, version: frozen.version }),
        { code: 'holder_global_backfill_run_stale' }
      );
    } finally {
      client.release();
    }
  });
});
