process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodInsiderShadowCandidateRepository,
} = require('../src/models/robinhood-insider-shadow-candidate');

const HASH = `0x${'a'.repeat(64)}`;
const CREATOR = `0x${'b'.repeat(40)}`;
const token = (id) => `0x${id.toString(16).padStart(40, '0')}`;
const TABLES = {
  robinhood_holder_token_states: `chain varchar(16), token_address varchar(42),
    ledger_status varchar(16), live_through_block bigint, live_through_hash varchar(66),
    PRIMARY KEY (chain, token_address)`,
  robinhood_token_attributions: `chain varchar(16), token_address varchar(42),
    creator_address varchar(42), attribution_block bigint,
    PRIMARY KEY (chain, token_address)`,
  robinhood_wallet_transfer_cursors: `chain varchar(16), projection_version varchar(64),
    stream varchar(16), lifecycle_state varchar(16), next_block bigint,
    PRIMARY KEY (chain, projection_version, stream)`,
  robinhood_holder_classification_states: `chain varchar(16), token_address varchar(42),
    classifier varchar(16), classification_version varchar(64), status varchar(16),
    through_block_number bigint, through_block_hash varchar(66), updated_at timestamptz,
    PRIMARY KEY (chain, token_address, classifier, classification_version)`,
  robinhood_directional_transfer_replay_runs: `chain varchar(16),
    projection_version varchar(64), status varchar(16)`,
};

function planNodes(node) {
  return [node, ...(node.Plans || []).flatMap(planNodes)];
}

describe('Robinhood INSIDER shadow candidate replay prerequisite', () => {
  let client;
  let candidates;
  let candidateQuery;

  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Session-local projections isolate the SQL contract and plan from shared fixtures.
    for (const [name, columns] of Object.entries(TABLES)) {
      await client.query(`CREATE TEMP TABLE ${name} (${columns}) ON COMMIT DROP`);
    }
    await client.query(`INSERT INTO robinhood_holder_token_states
      SELECT 'robinhood', '0x' || lpad(to_hex(id), 40, '0'), 'live', 100, $1
      FROM generate_series(1, 1000) id`, [HASH]);
    await client.query(`INSERT INTO robinhood_token_attributions
      SELECT chain, token_address, $1, 100 FROM robinhood_holder_token_states`, [CREATOR]);
    await client.query(`INSERT INTO robinhood_wallet_transfer_cursors
      VALUES ('robinhood', 'rh_transfer_v1', 'live', 'running', 200)`);
    await client.query(`INSERT INTO robinhood_holder_classification_states
      SELECT chain, token_address, 'insider', 'rh_holder_v1', 'ready', 100, $1, NOW()
      FROM robinhood_holder_token_states WHERE token_address > $2`, [HASH, token(10)]);
    await client.query(`INSERT INTO robinhood_holder_classification_states VALUES
      ('robinhood', $1, 'insider', 'rh_holder_v1', 'ready', 100, $4, NOW()),
      ('robinhood', $2, 'insider', 'rh_holder_v1', 'ready', 99, $4, NOW()),
      ('robinhood', $3, 'insider', 'rh_holder_v1', 'pending', NULL, NULL, NOW())`,
    [token(2), token(3), token(4), HASH]);
    await client.query(`INSERT INTO robinhood_holder_classification_states VALUES
      ('robinhood', $1, 'insider', 'rh_holder_v1', 'pending', NULL, NULL,
        NOW() - INTERVAL '2 hours')`, [token(5)]);
    await client.query(`UPDATE robinhood_token_attributions SET creator_address = $2
      WHERE token_address = $1`, [token(6), `0x${'0'.repeat(40)}`]);
    await client.query(`UPDATE robinhood_holder_token_states SET live_through_block = 200
      WHERE token_address = $1`, [token(7)]);
    await client.query(`UPDATE robinhood_holder_token_states SET ledger_status = 'shadow'
      WHERE token_address = $1`, [token(8)]);
    await client.query(`UPDATE robinhood_token_attributions SET attribution_block = 101
      WHERE token_address = $1`, [token(9)]);
    await client.query(`UPDATE robinhood_holder_token_states SET live_through_hash = NULL
      WHERE token_address = $1`, [token(10)]);
    for (const name of Object.keys(TABLES)) await client.query(`ANALYZE ${name}`);
    candidates = createRobinhoodInsiderShadowCandidateRepository({
      database: { async query(sql, params) {
        candidateQuery = { sql, params };
        return client.query(sql, params);
      } },
    });
  });

  beforeEach(async () => {
    await client.query('TRUNCATE robinhood_directional_transfer_replay_runs');
  });

  after(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await db.pool.end();
  });

  it('does not scan token state, attribution or classification before replay coverage is ready', async () => {
    await client.query(`INSERT INTO robinhood_directional_transfer_replay_runs VALUES
      ('robinhood', 'rh_transfer_v1', 'running')`);
    assert.deepEqual(await candidates.listCandidates({ limit: 2 }), []);
    const { rows } = await client.query(
      `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${candidateQuery.sql}`, candidateQuery.params
    );
    const tokenScans = planNodes(rows[0]['QUERY PLAN'][0].Plan).filter((node) => [
      'robinhood_holder_token_states', 'robinhood_token_attributions',
      'robinhood_holder_classification_states',
    ].includes(node['Relation Name']));
    for (const scan of tokenScans) {
      assert.equal(scan['Actual Loops'], 0, `${scan['Relation Name']} must not be scanned`);
    }
  });

  it('keeps paused, failed and other projection replays closed', async () => {
    for (const status of ['paused', 'failed']) {
      await client.query('INSERT INTO robinhood_directional_transfer_replay_runs VALUES ($1, $2, $3)',
        ['robinhood', 'rh_transfer_v1', status]);
    }
    await client.query(`INSERT INTO robinhood_directional_transfer_replay_runs VALUES
      ('robinhood', 'other_transfer_v1', 'completed')`);
    assert.deepEqual(await candidates.listCandidates(), []);
  });

  it('preserves eligibility, ordering and pagination after the matching replay completes', async () => {
    await client.query(`INSERT INTO robinhood_directional_transfer_replay_runs VALUES
      ('robinhood', 'rh_transfer_v1', 'completed')`);
    assert.deepEqual(await candidates.listCandidates(), [token(1), token(3), token(5)]);
    assert.deepEqual(await candidates.listCandidates({ limit: 2 }), [token(1), token(3)]);
    assert.deepEqual(await candidates.listCandidates({ afterToken: token(3) }), [token(5)]);
    await client.query("UPDATE robinhood_wallet_transfer_cursors SET lifecycle_state = 'pending'");
    assert.deepEqual(await candidates.listCandidates(), []);
  });
});
