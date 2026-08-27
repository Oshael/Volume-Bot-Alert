process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodPossibleBundleSource } = require(
  '../src/models/robinhood-possible-bundle-source'
);
const stage63 = require('../src/utils/db-init-stage63');
const stage145 = require('../src/utils/db-init-stage145');
const stage167 = require('../src/utils/db-init-stage167');
const stage168 = require('../src/utils/db-init-stage168');
const stage169 = require('../src/utils/db-init-stage169');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET_A = `0x${'2'.repeat(40)}`;
const WALLET_B = `0x${'3'.repeat(40)}`;
const FUNDER = `0x${'4'.repeat(40)}`;
const BUNDLE = `0x${'b'.repeat(64)}`;
const TX = `0x${'c'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_possible_bundle_members');
  await db.query('DELETE FROM robinhood_possible_bundle_groups');
  await db.query('DELETE FROM robinhood_possible_bundle_states');
  await db.query('DELETE FROM robinhood_bundle_funding_evidence');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_ranges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_candidates');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs');
  await db.query('DELETE FROM robinhood_infrastructure_registry WHERE address = $1', [FUNDER]);
}

describe('Robinhood possible-bundle schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage145.init({ closePool: false });
    await stage167.init({ closePool: false });
    await stage168.init({ closePool: false });
    await stage169.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('persists one bounded group and enforces policy, source, and launch position', async () => {
    const source = await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
      source_from_block, source_through_block, source_through_hash, lookback_blocks,
      batch_blocks, concurrency, candidate_count, range_count, blocks_total,
      status, started_at, finished_at
    ) VALUES (0, 200, $1, 1000, 50, 16, 2, 1, 100, 'completed', NOW(), NOW())
    RETURNING id`, [HASH]);
    const runId = source.rows[0].id;
    await db.query(`INSERT INTO robinhood_possible_bundle_states (
      token_address, rule_version, evidence_version, status, status_reason,
      source_kind, source_run_id, lookback_blocks, minimum_value_wei,
      through_block_number, through_block_hash, observed_at
    ) VALUES ($1, 'rh_possible_bundle_v1', 'rh_native_funding_v1', 'ready',
      'materialized', 'seed', $2, 1000, 10, 200, $3, NOW())`, [TOKEN, runId, HASH]);
    await assert.rejects(db.query(`INSERT INTO robinhood_possible_bundle_states (
      token_address, rule_version, evidence_version, status, status_reason,
      source_kind, lookback_blocks, minimum_value_wei, observed_at
    ) VALUES ($1, 'rh_possible_bundle_v2', 'rh_native_funding_v1', 'pending',
      'waiting', 'seed', 1000, 0, NOW())`, [TOKEN]),
    /rh_possible_bundle_states_source_check|rh_possible_bundle_states_policy_check/);
    await assert.rejects(db.query(`INSERT INTO robinhood_possible_bundle_groups (
      token_address, rule_version, bundle_id, member_count, connection_count,
      qualifying_value_wei, evidence_json
    ) VALUES ($1, 'rh_possible_bundle_v1', $2, 1, 1, 10, '{"signal":"direct"}')`,
    [TOKEN, `0x${'c'.repeat(64)}`]), /rh_possible_bundle_groups_counts_check/);
    await db.query(`INSERT INTO robinhood_possible_bundle_groups (
      token_address, rule_version, bundle_id, member_count, connection_count,
      qualifying_value_wei, evidence_json
    ) VALUES ($1, 'rh_possible_bundle_v1', $2, 2, 1, 10,
      '{"signal":"connected_funding_launch_cluster"}')`, [TOKEN, BUNDLE]);
    const insertMember = (wallet, buyBlock, kind) => db.query(
      `INSERT INTO robinhood_possible_bundle_members (
         token_address, rule_version, bundle_id, wallet_address, launch_block,
         first_buy_block, first_buy_transaction_index, connection_kind, evidence_json
       ) VALUES ($1, 'rh_possible_bundle_v1', $2, $3, 100, $4, 0, $5, '{"hops":1}')`,
      [TOKEN, BUNDLE, wallet, buyBlock, kind]
    );
    await insertMember(WALLET_A, 100, 'direct_member_funding');
    await insertMember(WALLET_B, 103, 'connected_funding_ancestor');
    await assert.rejects(insertMember(`0x${'4'.repeat(40)}`, 104, 'mixed'),
      /rh_possible_bundle_members_position_check/);
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_possible_bundle_members'
    )).rows[0].count, 2);
  });

  it('reads completed v2 lineage with exact evidence and temporal barriers', async () => {
    const source = await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
      evidence_version, source_from_block, source_through_block, source_through_hash,
      lookback_blocks, batch_blocks, concurrency, candidate_count, range_count,
      blocks_total, status, started_at, finished_at
    ) VALUES ('rh_native_funding_v2', 0, 200, $1, 1000, 50, 16, 2, 1, 100,
      'completed', NOW(), NOW()) RETURNING id`, [HASH]);
    const runId = source.rows[0].id;
    await db.query(`INSERT INTO robinhood_bundle_funding_backfill_candidates (
      run_id, token_address, wallet_address, launch_block, first_buy_block,
      first_buy_transaction_index
    ) VALUES ($1, $2, $3, 100, 101, 0), ($1, $2, $4, 100, 102, 0)`,
    [runId, TOKEN, WALLET_A, WALLET_B]);
    await db.query(`INSERT INTO robinhood_bundle_funding_evidence (
      run_id, token_address, candidate_wallet, hop, block_number, block_hash,
      block_time, transaction_hash, transaction_index, from_wallet, to_wallet, value_wei
    ) VALUES ($1, $2, $3, 1, 99, $4, NOW(), $5, 0, $6, $3, 10)`,
    [runId, TOKEN, WALLET_A, HASH, TX, FUNDER]);
    await db.query(`INSERT INTO robinhood_infrastructure_registry (
      address, kind, label, source, evidence_json, valid_from_block, verified_at
    ) VALUES ($1, 'cex', 'fixture', 'integration_fixture', '{"case":"bundle"}', 90, NOW())`,
    [FUNDER]);

    const result = await createRobinhoodPossibleBundleSource({ database: db })
      .loadSeedToken({ runId, tokenAddress: TOKEN });
    assert.equal(result.ready, true);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.evidence.length, 1);
    assert.deepEqual(result.barrierAddresses, [FUNDER]);
    assert.equal(result.throughBlockHash, HASH);
  });
});
