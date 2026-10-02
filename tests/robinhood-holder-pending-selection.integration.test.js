process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodHolderLedgerRepository,
} = require('../src/models/robinhood-holder-ledger');

const token = (id) => `0x${id.toString(16).padStart(40, '0')}`;
const EXPECTED = [8, 9, 3, 2, 11, 1].map(token);

function planNodes(node) {
  return [node, ...(node.Plans || []).flatMap(planNodes)];
}

describe('Robinhood holder pending journal fallback', () => {
  let client;
  let ledger;
  let selectionQuery;

  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query(`CREATE TEMP TABLE robinhood_holder_token_states (
      chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
      ledger_status varchar(16) NOT NULL, PRIMARY KEY (chain, token_address)
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal (
      chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
      block_number bigint NOT NULL, transaction_index int NOT NULL,
      log_index int NOT NULL, applied boolean NOT NULL,
      PRIMARY KEY (chain, token_address, block_number, transaction_index, log_index)
    ) ON COMMIT DROP`);
    await client.query(`CREATE INDEX pending_journal_fixture
      ON robinhood_holder_transfer_journal
      (chain, token_address, block_number, transaction_index, log_index)
      WHERE applied = false`);
    ledger = createRobinhoodHolderLedgerRepository({
      database: { async query(sql, params) {
        selectionQuery = { sql, params };
        return client.query(sql, params);
      } },
    });
  });

  beforeEach(async () => {
    await client.query('TRUNCATE robinhood_holder_token_states, robinhood_holder_transfer_journal');
    await client.query(`INSERT INTO robinhood_holder_token_states
      SELECT 'robinhood', '0x' || lpad(to_hex(id), 40, '0'),
        CASE WHEN id IN (2, 8, 11) THEN 'shadow'
             WHEN id = 4 THEN 'backfilling' WHEN id = 5 THEN 'resyncing' ELSE 'live' END
      FROM generate_series(1, 5000) id WHERE id <> 6`);
    for (const [id, block, tx, log, applied] of [
      [1, 100, 0, 0, false], [1, 200, 0, 0, false], [2, 150, 0, 0, false],
      [3, 150, 0, 0, false], [4, 500, 0, 0, false], [5, 600, 0, 0, false],
      [6, 700, 0, 0, false], [7, 150, 0, 0, true], [8, 150, 1, 0, false],
      [9, 150, 0, 1, false], [11, 150, 0, 0, false],
    ]) {
      await client.query('INSERT INTO robinhood_holder_transfer_journal VALUES ($1,$2,$3,$4,$5,$6)',
        ['robinhood', token(id), block, tx, log, applied]);
    }
    await client.query('INSERT INTO robinhood_holder_token_states VALUES ($1,$2,$3)',
      ['ethereum', token(12), 'live']);
    await client.query('INSERT INTO robinhood_holder_transfer_journal VALUES ($1,$2,99999,0,0,false)',
      ['ethereum', token(12)]);
    await client.query('ANALYZE robinhood_holder_token_states');
    await client.query('ANALYZE robinhood_holder_transfer_journal');
  });

  after(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await db.pool.end();
  });

  async function explainSelection() {
    const { rows } = await client.query(
      `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${selectionQuery.sql}`, selectionQuery.params
    );
    return planNodes(rows[0]['QUERY PLAN'][0].Plan);
  }

  it('finds sparse pendencies without probing the journal for every idle tracked token', async () => {
    assert.deepEqual(await ledger.listPendingTokenAddresses(), EXPECTED);
    const journalScans = (await explainSelection())
      .filter((node) => node['Relation Name'] === 'robinhood_holder_transfer_journal');
    const probes = journalScans.reduce((total, node) => total + node['Actual Loops'], 0);
    assert.ok(probes < 100, `sparse pending selection performed ${probes} journal probes`);
  });

  it('preserves exclusions, limits and disjoint shard coverage in both selection paths', async () => {
    for (const overflow of [false, true]) {
      if (overflow) {
        // Untracked journal tokens also exhaust the fast budget, but remain ineligible.
        await client.query(`INSERT INTO robinhood_holder_transfer_journal
          SELECT 'robinhood', '0x' || lpad(to_hex(id), 40, '0'), 9000, 0, 0, false
          FROM generate_series(10000, 10512) id`);
      }
      assert.deepEqual(await ledger.listPendingTokenAddresses({ limit: 2 }), EXPECTED.slice(0, 2));
      assert.deepEqual(await ledger.listPendingTokenAddresses({
        excludeTokenAddresses: [token(8), token(3)],
      }), [9, 2, 11, 1].map(token));
      const shards = [];
      for (const shardIndex of [0, 1]) {
        shards.push(await ledger.listPendingTokenAddresses({ shardCount: 2, shardIndex }));
      }
      assert.deepEqual([...shards[0], ...shards[1]].sort(), [...EXPECTED].sort());
      assert.deepEqual(shards[0].filter((address) => shards[1].includes(address)), []);
      for (const shard of shards) {
        assert.deepEqual(shard, EXPECTED.filter((address) => shard.includes(address)));
      }
    }
  });

  it('keeps 512 distinct pending tokens bounded and selects beyond the witness at 513', async () => {
    await client.query('TRUNCATE robinhood_holder_transfer_journal');
    await client.query(`INSERT INTO robinhood_holder_transfer_journal
      SELECT 'robinhood', '0x' || lpad(to_hex(id), 40, '0'), id, 0, 0, false
      FROM generate_series(100, 611) id`);
    const ordered = Array.from({ length: 512 }, (_, index) => token(611 - index));
    assert.deepEqual(await ledger.listPendingTokenAddresses(), ordered);
    const scans = (await explainSelection())
      .filter((node) => node['Relation Name'] === 'robinhood_holder_transfer_journal');
    assert.ok(scans.reduce((sum, node) => sum + node['Actual Loops'], 0) < 600);
    // This last address must outrank the fast walk's first 512 tokens.
    await client.query('INSERT INTO robinhood_holder_transfer_journal VALUES ($1,$2,10000,0,0,false)',
      ['robinhood', token(612)]);
    assert.deepEqual(await ledger.listPendingTokenAddresses(), [token(612), ...ordered]);
    assert.deepEqual(await ledger.listPendingTokenAddresses({ limit: 1 }), [token(612)]);
  });

  it('returns no candidates for an empty journal or only applied transfers', async () => {
    await client.query('UPDATE robinhood_holder_transfer_journal SET applied = true');
    assert.deepEqual(await ledger.listPendingTokenAddresses(), []);
    await client.query('TRUNCATE robinhood_holder_transfer_journal');
    assert.deepEqual(await ledger.listPendingTokenAddresses(), []);
  });
});
