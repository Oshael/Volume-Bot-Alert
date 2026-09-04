const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderBootstrapRepository,
} = require('../src/models/robinhood-holder-bootstrap');

const TOKENS = ['a', 'b', 'c', 'd', 'e', 'f'].map((digit) => `0x${digit.repeat(40)}`);

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
      await client.query(`CREATE TEMP TABLE robinhood_holder_cursors
        (LIKE public.robinhood_holder_cursors INCLUDING ALL)`);
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
          ('robinhood', $5, '2026-08-10T00:04:00Z'),
          ('robinhood', $6, '2026-08-10T00:05:00Z')`, TOKENS
      );
      await client.query(
        `INSERT INTO robinhood_token_attributions VALUES
          ('robinhood', $1, 'rpc_direct', 101),
          ('robinhood', $2, 'rpc_direct', 99),
          ('robinhood', $3, 'blockscout', NULL),
          ('robinhood', $4, 'launchpad_event', 104),
          ('robinhood', $5, 'rpc_direct', 105),
          ('robinhood', $6, 'rpc_direct', 100)`, TOKENS
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
      await client.query(
        `INSERT INTO robinhood_holder_cursors (
           next_block, safe_head, journal_floor_block, buffer_floor_block
         ) VALUES (201, 200, 90, 101)`
      );
      let inspectDiscovery = true;
      let beforeAdmission = null;
      const database = {
        async query(sql, params) {
          if (!inspectDiscovery) {
            const result = await client.query(sql, params);
            if (beforeAdmission) {
              const change = beforeAdmission;
              beforeAdmission = null;
              await change();
            }
            return result;
          }
          inspectDiscovery = false;
          // Keep the discovery statement's locks visible until we inspect them.
          await client.query('BEGIN');
          try {
            const result = await client.query(sql, params);
            const locks = await client.query(`SELECT mode FROM pg_locks
              WHERE pid = pg_backend_pid()
                AND relation = 'robinhood_holder_cursors'::regclass
                AND mode <> 'AccessShareLock' AND granted`);
            assert.deepEqual(locks.rows, [], 'catalog discovery must not lock the live cursor');
            return result;
          } finally { await client.query('ROLLBACK'); }
        },
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const repository = createRobinhoodHolderBootstrapRepository({ database });
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10, maxInitialGapBlocks: 101,
      }), [{
        tokenAddress: TOKENS[0], deploymentBlock: '101',
        backfillNextBlock: '101', ledgerStatus: 'shadow',
      }, {
        tokenAddress: TOKENS[5], deploymentBlock: '100',
        backfillNextBlock: '100', ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10, maxInitialGapBlocks: 101,
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
        tokenAddress: TOKENS[0], holderCount: '0', ledgerStatus: 'shadow',
        deploymentBlock: '101', backfillNextBlock: '101',
      }, {
        tokenAddress: TOKENS[1], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '99', backfillNextBlock: '99',
      }, {
        tokenAddress: TOKENS[3], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '104', backfillNextBlock: '104',
      }, {
        tokenAddress: TOKENS[5], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '100', backfillNextBlock: '100',
      }]);
      const cursor = await client.query(
        `SELECT version, buffer_floor_block FROM robinhood_holder_cursors`
      );
      assert.deepEqual(cursor.rows.map((row) => ({
        version: Number(row.version), bufferFloorBlock: String(row.buffer_floor_block),
      })), [{ version: 0, bufferFloorBlock: '101' }]);

      // Changes committed between discovery and admission must win over stale hints.
      const late = ['1', '2', '3', '4', '5', '6'].map((digit) => `0x${digit.repeat(40)}`);
      await client.query(`INSERT INTO token_catalog
        SELECT 'robinhood', token, '2026-08-10T00:10:00Z'::timestamptz
          FROM unnest($1::varchar[]) token`, [late]);
      await client.query(`INSERT INTO robinhood_token_attributions
        SELECT 'robinhood', token, 'rpc_direct', block
          FROM unnest($1::varchar[], $2::bigint[]) AS input(token, block)`,
        [late, [120, 110, 125, 126, 127, 128]]);
      beforeAdmission = async () => {
        await client.query(`UPDATE robinhood_holder_cursors
          SET next_block = 221, safe_head = 220, journal_floor_block = 121`);
        await client.query(`UPDATE robinhood_token_attributions SET source = 'blockscout'
          WHERE token_address = $1`, [late[2]]);
        await client.query(`INSERT INTO robinhood_holder_global_backfill_tokens
          (run_id, token_address) VALUES ($1, $2)`, [run.rows[0].id, late[3]]);
        await client.query(`INSERT INTO robinhood_holder_token_states
          (token_address, ledger_status, holder_count, deployment_block, backfill_next_block)
          VALUES ($1, 'live', 7, 127, 127)`, [late[4]]);
      };
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10, maxInitialGapBlocks: 101,
      }), [{
        tokenAddress: late[0], deploymentBlock: '120',
        backfillNextBlock: '120', ledgerStatus: 'backfilling',
      }, {
        tokenAddress: late[5], deploymentBlock: '128',
        backfillNextBlock: '128', ledgerStatus: 'shadow',
      }]);
      assert.deepEqual((await client.query(`SELECT token_address, holder_count::text
        FROM robinhood_holder_token_states WHERE token_address = ANY($1::varchar[])
        ORDER BY token_address`, [late])).rows, [
        { token_address: late[0], holder_count: '0' },
        { token_address: late[4], holder_count: '7' },
        { token_address: late[5], holder_count: '0' },
      ]);
    } finally {
      client.release();
    }
  });
});
