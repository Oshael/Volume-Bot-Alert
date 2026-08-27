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
const stage169 = require('../src/utils/db-init-stage169');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'7'.repeat(40)}`;
const WALLET_A = `0x${'8'.repeat(40)}`;
const WALLET_B = `0x${'9'.repeat(40)}`;
const FUNDER = `0x${'6'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const MARKET_KEY = 'possible-bundle-source-test-v4';
let runId;

async function cleanup() {
  if (runId) {
    await db.query('DELETE FROM robinhood_bundle_funding_evidence WHERE run_id = $1', [runId]);
    await db.query(
      'DELETE FROM robinhood_bundle_funding_backfill_candidates WHERE run_id = $1', [runId]
    );
    await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs WHERE id = $1', [runId]);
  }
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET_KEY]);
  await db.query(`DELETE FROM robinhood_infrastructure_registry
    WHERE address = $1 AND source = 'possible_bundle_source_test'`, [FUNDER]);
}

describe('Robinhood possible-bundle PostgreSQL source integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage145.init({ closePool: false });
    await stage167.init({ closePool: false });
    await stage169.init({ closePool: false });
    await cleanup();
    runId = (await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
      evidence_version, source_from_block, source_through_block, source_through_hash,
      lookback_blocks, batch_blocks, concurrency, candidate_count, range_count,
      blocks_total, status, started_at, finished_at
    ) VALUES ('rh_native_funding_v2', 0, 200, $1, 1000, 50, 2, 2, 0, 0,
      'completed', NOW(), NOW()) RETURNING id::text`, [HASH])).rows[0].id;
    await db.query(`INSERT INTO robinhood_bundle_funding_backfill_candidates (
      run_id, token_address, wallet_address, launch_block, first_buy_block,
      first_buy_transaction_index
    ) VALUES ($1, $2, $3, 100, 101, 0), ($1, $2, $4, 100, 102, 0)`,
    [runId, TOKEN, WALLET_A, WALLET_B]);
    await db.query(`INSERT INTO robinhood_bundle_funding_evidence (
      run_id, token_address, candidate_wallet, hop, block_number, block_hash,
      block_time, transaction_hash, transaction_index, from_wallet, to_wallet,
      value_wei, evidence_version
    ) VALUES ($1, $2, $3, 1, 99, $4, NOW(), $5, 0, $6, $3, 50,
      'rh_native_funding_v2')`, [runId, TOKEN, WALLET_A, HASH, TX, FUNDER]);
    await db.query(`INSERT INTO robinhood_infrastructure_registry (
      address, kind, label, source, evidence_json, valid_from_block, verified_at
    ) VALUES ($1, 'cex', 'test cex', 'possible_bundle_source_test',
      '{"test":true}'::jsonb, 90, NOW())`, [FUNDER]);
    await db.query(`INSERT INTO robinhood_pool_registry (
      protocol, market_key, pool_id, origin_address, token_address, quote_address,
      currency0, currency1, discovery_block, discovery_block_hash,
      discovery_tx_hash, discovery_log_index, discovered_at
    ) VALUES ('uniswap-v4', $1, $2, $3, $4, $5, $4, $5, 100, $6, $7, 0, NOW())`,
    [MARKET_KEY, HASH, WALLET_B, TOKEN, WALLET_A, HASH, TX]);
  });

  after(async () => { await cleanup(); await db.pool.end(); });

  it('counts, pages and resolves barriers without rescanning funding tables', async () => {
    const source = createRobinhoodPossibleBundleSource({
      database: db, statementTimeoutMs: 10_000,
    });
    assert.equal(await source.countSeedTokens({ runId }), 1);
    assert.deepEqual(await source.listSeedTokens({ runId, limit: 10 }), [TOKEN]);
    const result = await source.loadSeedToken({ runId, tokenAddress: TOKEN });
    assert.equal(result.ready, true);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.evidence.length, 1);
    assert.deepEqual(result.barrierAddresses, [FUNDER, WALLET_B]);
  });
});
