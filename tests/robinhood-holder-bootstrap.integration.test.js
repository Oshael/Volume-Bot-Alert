process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodHolderBootstrapRepository,
} = require('../src/models/robinhood-holder-bootstrap');

const TOKENS = ['a', 'b', 'c', 'd', 'e', 'f'].map((digit) => `0x${digit.repeat(40)}`);

before(() => assertUsingTestDatabase(db));
after(() => db.pool.end());

describe('Robinhood holder bootstrap persistence', () => {
  it('avoids a state-index probe per catalog token when discovery finds no admissions', async () => {
    const tables = {
      token_catalog: `chain varchar(16), address varchar(42), first_seen_at timestamptz,
        PRIMARY KEY (chain, address)`,
      robinhood_holder_token_states: `chain varchar(16), token_address varchar(42),
        PRIMARY KEY (chain, token_address)`,
      robinhood_token_attributions: `chain varchar(16), token_address varchar(42),
        source varchar(32), attribution_block bigint, PRIMARY KEY (chain, token_address)`,
      robinhood_holder_cursors: `chain varchar(16), stream varchar(16), safe_head bigint,
        journal_floor_block bigint, buffer_floor_block bigint`,
      admin_blocked_tokens: 'chain varchar(16), address varchar(42)',
      robinhood_holder_global_backfill_tokens: `chain varchar(16), token_address varchar(42),
        run_id int, status varchar(16)`,
      robinhood_holder_global_backfill_runs: 'id int, chain varchar(16), status varchar(16)',
    };
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query('SET LOCAL random_page_cost = 1.1');
      await client.query("SET LOCAL work_mem = '64MB'");
      for (const [name, fields] of Object.entries(tables)) {
        await client.query(`CREATE TEMP TABLE ${name} (${fields}) ON COMMIT DROP`);
      }
      await client.query(`CREATE INDEX bootstrap_catalog_fixture
        ON token_catalog (chain, first_seen_at, address)`);
      await client.query(`INSERT INTO token_catalog
        SELECT 'robinhood', '0x' || lpad(to_hex(id), 40, '0'),
          CASE WHEN id <= 10000 THEN '2026-09-10T09:00:00Z'::timestamptz
               ELSE '2026-09-01T09:00:00Z'::timestamptz END
        FROM generate_series(1, 100000) id`);
      await client.query(`INSERT INTO robinhood_holder_token_states
        SELECT chain, address FROM token_catalog ORDER BY address LIMIT 9500`);
      await client.query(`INSERT INTO robinhood_holder_token_states
        SELECT 'robinhood', '0x' || lpad(to_hex(id), 40, '0')
        FROM generate_series(10001, 50500) id`);
      await client.query(`INSERT INTO robinhood_token_attributions
        SELECT catalog.chain, catalog.address,
          CASE WHEN state.token_address IS NULL THEN 'ambiguous' ELSE 'rpc_direct' END, 35001
        FROM token_catalog catalog LEFT JOIN robinhood_holder_token_states state
          ON state.chain=catalog.chain AND state.token_address=catalog.address`);
      await client.query(`INSERT INTO robinhood_holder_cursors
        VALUES ('robinhood', 'live', 50000, 40000, 35000)`);
      for (const name of Object.keys(tables)) await client.query(`ANALYZE ${name}`);
      let discovered;
      const repository = createRobinhoodHolderBootstrapRepository({
        database: { async query(sql, params) {
          discovered = { sql, params, rows: (await client.query(sql, params)).rows };
          // Exercise the real discovery SQL; leave writes to the admission contract below.
          return { rows: [] };
        } },
      });
      const options = { admittedAfter: '2026-09-10T08:30:00Z', limit: 100 };
      assert.deepEqual(await repository.seedNewTokens(options), []);
      assert.deepEqual(discovered.rows, []);
      const { rows } = await client.query(
        `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${discovered.sql}`, discovered.params
      );
      const nodes = (node) => [node, ...(node.Plans || []).flatMap(nodes)];
      const stateProbes = nodes(rows[0]['QUERY PLAN'][0].Plan)
        .filter((node) => node['Relation Name'] === 'robinhood_holder_token_states')
        .reduce((sum, node) => sum + node['Actual Loops'], 0);
      assert.ok(stateProbes < 100, `discovery performed ${stateProbes} state-index probes`);

      // Changing the read plan must preserve ordering, page size and readiness gates.
      const eligible = [9501, 9502].map((id) => `0x${id.toString(16).padStart(40, '0')}`);
      await client.query(`UPDATE robinhood_token_attributions SET source='rpc_direct'
        WHERE token_address=ANY($1::varchar[])`, [eligible]);
      await repository.seedNewTokens({ ...options, limit: 1 });
      assert.deepEqual(discovered.rows.map((row) => row.token_address), eligible.slice(0, 1));
      await repository.seedNewTokens(options);
      assert.deepEqual(discovered.rows.map((row) => row.token_address), eligible);
      await client.query(`UPDATE robinhood_holder_cursors
        SET journal_floor_block=NULL, buffer_floor_block=NULL`);
      await repository.seedNewTokens(options);
      assert.deepEqual(discovered.rows.map((row) => row.token_address), eligible);
      await client.query('UPDATE robinhood_holder_cursors SET safe_head=NULL');
      await repository.seedNewTokens(options);
      assert.deepEqual(discovered.rows, []);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

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
      await client.query(`CREATE TEMP TABLE admin_blocked_tokens (
        chain varchar(16) NOT NULL, address varchar(42) NOT NULL,
        PRIMARY KEY (chain, address)
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
      await client.query(`INSERT INTO admin_blocked_tokens VALUES ('robinhood', $1)`,
        [TOKENS[5]]);
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
        backfillNextBlock: '101', tailCaptureFromBlock: '201',
        ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10, maxInitialGapBlocks: 101,
      }), []);
      assert.deepEqual(await repository.seedColdTokens({
        admittedBefore: '2026-08-10T00:00:00Z', limit: 10,
      }), [{
        tokenAddress: TOKENS[1], deploymentBlock: '99',
        backfillNextBlock: '99', tailCaptureFromBlock: '201',
        ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual(await repository.seedColdTokens({
        admittedBefore: '2026-08-10T00:00:00Z', limit: 10,
      }), []);
      const states = await client.query(
        `SELECT token_address, holder_count, ledger_status,
                deployment_block, backfill_next_block, tail_capture_from_block
           FROM robinhood_holder_token_states ORDER BY token_address`
      );
      assert.deepEqual(states.rows.map((row) => ({
        tokenAddress: row.token_address, holderCount: String(row.holder_count),
        ledgerStatus: row.ledger_status, deploymentBlock: String(row.deployment_block),
        backfillNextBlock: String(row.backfill_next_block),
        tailCaptureFromBlock: row.tail_capture_from_block == null
          ? null : String(row.tail_capture_from_block),
      })), [{
        tokenAddress: TOKENS[0], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '101', backfillNextBlock: '101', tailCaptureFromBlock: '201',
      }, {
        tokenAddress: TOKENS[1], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '99', backfillNextBlock: '99', tailCaptureFromBlock: '201',
      }, {
        tokenAddress: TOKENS[3], holderCount: '0', ledgerStatus: 'backfilling',
        deploymentBlock: '104', backfillNextBlock: '104', tailCaptureFromBlock: null,
      }]);
      const cursor = await client.query(
        `SELECT version, buffer_floor_block FROM robinhood_holder_cursors`
      );
      assert.deepEqual(cursor.rows.map((row) => ({
        version: Number(row.version), bufferFloorBlock: String(row.buffer_floor_block),
      })), [{ version: 2, bufferFloorBlock: '101' }]);

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
        backfillNextBlock: '120', tailCaptureFromBlock: '221',
        ledgerStatus: 'backfilling',
      }, {
        tokenAddress: late[5], deploymentBlock: '128',
        backfillNextBlock: '128', tailCaptureFromBlock: '221',
        ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual((await client.query(`SELECT token_address, holder_count::text
        FROM robinhood_holder_token_states WHERE token_address = ANY($1::varchar[])
        ORDER BY token_address`, [late])).rows, [
        { token_address: late[0], holder_count: '0' },
        { token_address: late[4], holder_count: '7' },
        { token_address: late[5], holder_count: '0' },
      ]);

      // A temporary admission outage must not strand exact tokens while their
      // complete Transfer history is still retained by both live floors.
      const retained = `0x${'7'.repeat(40)}`;
      const expired = `0x${'8'.repeat(40)}`;
      await client.query(`UPDATE robinhood_holder_cursors
        SET next_block = 221, safe_head = 220,
            journal_floor_block = 100, buffer_floor_block = 100`);
      await client.query(`INSERT INTO token_catalog VALUES
        ('robinhood', $1, '2026-08-10T00:20:00Z'),
        ('robinhood', $2, '2026-08-10T00:21:00Z')`, [retained, expired]);
      await client.query(`INSERT INTO robinhood_token_attributions VALUES
        ('robinhood', $1, 'rpc_direct', 110),
        ('robinhood', $2, 'rpc_direct', 99)`, [retained, expired]);
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10, maxInitialGapBlocks: 50,
      }), [{
        tokenAddress: late[1], deploymentBlock: '110',
        backfillNextBlock: '110', tailCaptureFromBlock: '221',
        ledgerStatus: 'backfilling',
      }, {
        tokenAddress: retained, deploymentBlock: '110',
        backfillNextBlock: '110', tailCaptureFromBlock: '221',
        ledgerStatus: 'backfilling',
      }]);
      assert.equal((await client.query(`SELECT COUNT(*)::int AS count
        FROM robinhood_holder_token_states WHERE token_address = $1`, [expired])).rows[0].count, 0);

      // A token deployed ahead of a lagging live cursor starts its tail at the
      // deployment block; a pre-contract tail would violate the durable fence.
      const aheadLive = `0x${'9'.repeat(40)}`;
      const aheadCold = `0x${'0'.repeat(40)}`;
      await client.query(`INSERT INTO token_catalog VALUES
        ('robinhood', $1, '2026-08-10T00:30:00Z'),
        ('robinhood', $2, '2026-08-09T23:30:00Z')`, [aheadLive, aheadCold]);
      await client.query(`INSERT INTO robinhood_token_attributions VALUES
        ('robinhood', $1, 'rpc_direct', 230),
        ('robinhood', $2, 'rpc_direct', 240)`, [aheadLive, aheadCold]);
      assert.deepEqual(await repository.seedNewTokens({
        admittedAfter: '2026-08-10T00:00:00Z', limit: 10, maxInitialGapBlocks: 50,
      }), [{
        tokenAddress: aheadLive, deploymentBlock: '230',
        backfillNextBlock: '230', tailCaptureFromBlock: '230',
        ledgerStatus: 'backfilling',
      }]);
      assert.deepEqual(await repository.seedColdTokens({
        admittedBefore: '2026-08-10T00:00:00Z', limit: 10,
      }), [{
        tokenAddress: aheadCold, deploymentBlock: '240',
        backfillNextBlock: '240', tailCaptureFromBlock: '240',
        ledgerStatus: 'backfilling',
      }]);
    } finally {
      client.release();
    }
  });
});
