process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletTransferLiveSourceRepository,
} = require('../src/models/robinhood-wallet-transfer-live-source');
const { createRobinhoodTransferClassifier } = require('../src/services/robinhood-transfer-classifier');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage91 = require('../src/utils/db-init-stage91');
const stage116 = require('../src/utils/db-init-stage116');
const stage120 = require('../src/utils/db-init-stage120');
const stage122 = require('../src/utils/db-init-stage122');
const stage133 = require('../src/utils/db-init-stage133');
const stage129 = require('../src/utils/db-init-stage129');
const stage134 = require('../src/utils/db-init-stage134');
const stage135 = require('../src/utils/db-init-stage135');
const stage264 = require('../src/utils/db-init-stage264');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
const ROUTER = `0x${'4'.repeat(40)}`;
const MANAGER = `0x${'5'.repeat(40)}`;
const INACTIVE_MANAGER = `0x${'6'.repeat(40)}`;
const OTHER_MANAGER = `0x${'7'.repeat(40)}`;
const V3_POOL = `0x${'8'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const PARTITION = 'robinhood_wallet_swaps_2099_02_01';

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_swaps WHERE transaction_hash = $1', [TX]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key LIKE $1', ['test-transfer-source%']);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query("DELETE FROM robinhood_wallet_swap_cursors WHERE chain = 'robinhood' AND stream IN ('seed', 'live')");
  await db.query("DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = 'test_transfer_plan_v1'");
  await db.query('DELETE FROM robinhood_wallet_endpoint_roles WHERE endpoint_address = $1', [POOL]);
}

describe('Robinhood wallet transfer LIVE source', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage63, stage90, stage91, stage116, stage120, stage122, stage133, stage129, stage134,
      stage135, stage264,
    ]) {
      await stage.init({ closePool: false });
    }
    await db.query(`CREATE TABLE IF NOT EXISTS ${PARTITION}
      PARTITION OF robinhood_wallet_swaps
      FOR VALUES FROM ('2099-02-01T00:00:00.000Z') TO ('2099-02-02T00:00:00.000Z')`);
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.query(`DROP TABLE IF EXISTS ${PARTITION}`);
    await db.pool.end();
  });

  it('exposes only proven swap coverage and bounded classification context', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_swap_cursors (
         chain, stream, origin_block, next_block, safe_head, lifecycle_state, completed_at
       ) VALUES ('robinhood', 'seed', 100, 101, 100, 'complete', NOW())`
    );
    await db.query(
      `INSERT INTO robinhood_wallet_swap_cursors (
         chain, stream, origin_block, next_block, safe_head, checkpoint_block, checkpoint_hash,
         checkpoint_timestamp, lifecycle_state
       ) VALUES ('robinhood', 'live', 101, 120, 150, 119, $1,
         '2099-02-01T00:00:00Z', 'running')`,
      [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         chain, projection_version, stream, origin_block, next_block,
         next_block_time, safe_head, lifecycle_state
       ) VALUES ('robinhood', 'test_transfer_plan_v1', 'live', 110, 120, NOW(), 150, 'running')`
    );
    await db.query(
      `INSERT INTO robinhood_holder_token_states (chain, token_address, ledger_status)
       VALUES ('robinhood', $1, 'live')`, [TOKEN]
    );
    await db.query(
      `INSERT INTO robinhood_pool_registry (
         chain, protocol, market_key, pool_address, origin_address, token_address,
         quote_address, currency0, currency1, discovery_block, discovery_block_hash,
         discovery_tx_hash, discovery_log_index, discovered_at
       ) VALUES ('robinhood', 'uniswap-v2', 'test-transfer-source', $1, $3, $2,
         $3, $2, $3, 1, $4, $5, 1, NOW()),
         ('robinhood', 'uniswap-v3', 'test-transfer-source-v3', $6, $3, $2,
         $3, $2, $3, 1, $4, $5, 1, NOW())`,
      [POOL, TOKEN, ROUTER, HASH, TX, V3_POOL]
    );
    await db.query(
      `INSERT INTO robinhood_pool_registry (
         chain, protocol, market_key, pool_id, origin_address, token_address,
         quote_address, currency0, currency1, discovery_block, discovery_block_hash,
         discovery_tx_hash, discovery_log_index, discovered_at, active
       ) SELECT 'robinhood', 'uniswap-v4', 'test-transfer-source-v4-' || id,
         '0x' || repeat('e', 60) || lpad(to_hex(id), 4, '0'),
         CASE WHEN id <= 128 THEN $1 WHEN id = 129 THEN $2 ELSE $3 END,
         $4, $5, $4, $5, 1, $6, $7, id, NOW(), id <> 129
       FROM generate_series(1, 130) AS fixture(id)`,
      [MANAGER, INACTIVE_MANAGER, OTHER_MANAGER, TOKEN, ROUTER, HASH, TX]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_swaps (
         chain, wallet_address, transaction_hash, action_index, block_number,
         block_time, protocol, market_key, token_address, quote_address, side,
         token_amount_raw, quote_amount_raw, router_address, parser_version
       ) VALUES ('robinhood', $1, $2, 7, 110, '2099-02-01T12:00:00Z',
         'uniswap-v2', 'test-transfer-source', $3, $4, 'buy', 25, 5, $5, 'test-v1')`,
      [WALLET, TX, TOKEN, ROUTER, ROUTER]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_endpoint_roles (
         chain, endpoint_address, endpoint_role, evidence_source, evidence_block,
         evidence_block_hash, resolver_version, observed_from_block, observed_through_block
       ) VALUES ('robinhood', $1, 'contract', 'pc_archive', 110, $2,
         'rh_endpoint_v1', 110, 110)`,
      [POOL, HASH]
    );

    const poolPayloadSizes = [];
    const poolQueries = [];
    const repository = createRobinhoodWalletTransferLiveSourceRepository({
      database: { async query(sql, parameters) {
        const result = await db.query(sql, parameters);
        if (sql.includes('FROM robinhood_pool_registry')) {
          poolPayloadSizes.push(result.rows.length);
          poolQueries.push({ sql, parameters });
        }
        return result;
      } },
    });
    const frontier = await repository.loadSwapFrontier();
    const backfillFrontier = await repository.loadBackfillFrontier();
    const backfillPlan = await repository.loadBackfillPlan('test_transfer_plan_v1');
    const tokens = await repository.listTrackedTokenAddresses();
    const context = await repository.loadRangeContext({
      fromBlock: '100', toBlock: '119',
      transactionHashes: [TX],
      endpointAddresses: [WALLET, POOL, V3_POOL, ROUTER, MANAGER, INACTIVE_MANAGER, OTHER_MANAGER],
      fromTime: '2099-02-01T00:00:00Z', toTime: '2099-02-01T23:59:59Z',
    });
    const backfillContext = await repository.loadBackfillRangeContext({
      fromBlock: '100', toBlock: '119',
      transactionHashes: [TX],
      endpointAddresses: [WALLET, POOL, V3_POOL, ROUTER, MANAGER, INACTIVE_MANAGER, OTHER_MANAGER],
      fromTime: '2099-02-01T00:00:00Z', toTime: '2099-02-01T23:59:59Z',
    });

    assert.equal(frontier.ready, true);
    assert.equal(frontier.completeThroughBlock, '119');
    assert.equal(backfillFrontier.ready, true);
    assert.equal(backfillFrontier.historicalFromBlock, '100');
    assert.equal(backfillFrontier.historicalThroughBlock, '100');
    assert.equal(backfillFrontier.completeThroughBlock, '119');
    assert.equal(backfillPlan.ready, true);
    assert.equal(backfillPlan.fromBlock, '100');
    assert.equal(backfillPlan.throughBlock, '109');
    assert.equal(backfillPlan.remainingBlocks, '10');
    assert.equal(tokens.includes(TOKEN), true);
    assert.equal(context.swapCoverageComplete, true);
    assert.equal(context.swaps.length, 1);
    assert.deepEqual(context.poolAddresses, [POOL, V3_POOL, MANAGER, OTHER_MANAGER].sort());
    assert.deepEqual(context.routerAddresses, [ROUTER]);
    assert.deepEqual(context.contractAddresses, [POOL]);
    assert.deepEqual(context.contractRoleEvidence, [{
      evidenceBlock: '110', evidenceBlockHash: HASH,
      endpointAddress: POOL, observedFromBlock: '110', observedThroughBlock: '110',
    }]);
    assert.deepEqual(context.walletAddresses, [WALLET]);
    assert.deepEqual(context.endpointRoleCoverage, {
      requested: 7, persisted: 1, unpersisted: 6, probes: 0,
    });
    assert.equal(backfillContext.ready, true);
    assert.deepEqual(backfillContext.poolAddresses, context.poolAddresses);
    assert.deepEqual(backfillContext.rpcExemptAddresses,
      [POOL, V3_POOL, MANAGER, OTHER_MANAGER, ROUTER, WALLET].sort());
    assert.deepEqual(backfillContext.contextQueryChunks, {
      transactionHashes: 1, endpointAddresses: 1,
    });
    assert.equal(backfillContext.swaps.length, 1);
    for (const rangeContext of [context, backfillContext]) {
      const classifier = createRobinhoodTransferClassifier(rangeContext);
      for (const [toWallet, kind] of [
        [POOL, 'liquidity_flow'], [V3_POOL, 'liquidity_flow'], [MANAGER, 'liquidity_flow'],
        [ROUTER, 'router_flow'], [INACTIVE_MANAGER, 'unknown'], [OTHER_MANAGER, 'liquidity_flow'],
      ]) {
        const result = classifier.classify({
          transactionHash: `0x${'c'.repeat(64)}`, logIndex: '1', tokenAddress: TOKEN,
          fromWallet: WALLET, toWallet, amountRaw: '1',
        }, rangeContext);
        assert.equal(result.kind, kind);
        assert.equal(result.affectsPosition, false);
        assert.equal(result.connectionEligible, false);
      }
    }
    // The SQL payload must scale with endpoint identities, not V4 pool count.
    assert.deepEqual(poolPayloadSizes, [4, 4]);
    // Inspect actual work, not just the deduplicated payload. Disabling sequential
    // scans makes index eligibility deterministic even with this small fixture.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { sql, parameters } = poolQueries[0];
      const explained = await client.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, parameters
      );
      const nodes = [explained.rows[0]['QUERY PLAN'][0].Plan];
      for (let i = 0; i < nodes.length; i++) nodes.push(...(nodes[i].Plans || []));
      const managerScan = nodes.find((node) => node['Index Name'] === stage264.INDEX_NAME);
      assert.ok(managerScan, 'active V4 managers must support an indexed lookup');
      assert.equal(managerScan['Actual Loops'], parameters[1].length);
      assert.ok(managerScan['Actual Rows'] <= 1, 'each lookup stops at its first match');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.equal((await repository.loadBackfillRangeContext({
      fromBlock: '99', toBlock: '100', transactionHashes: [], endpointAddresses: [],
      fromTime: '2099-02-01T00:00:00Z', toTime: '2099-02-01T23:59:59Z',
    })).reason, 'swap_coverage_before_seed');

    const uncovered = await repository.loadRangeContext({
      fromBlock: '120', toBlock: '120', transactionHashes: [], endpointAddresses: [],
      fromTime: '2099-02-01T00:00:00Z', toTime: '2099-02-01T23:59:59Z',
    });
    assert.equal(uncovered.reason, 'swap_coverage_incomplete');

    await db.query(
      "UPDATE robinhood_wallet_swap_cursors SET safe_head = 100 WHERE chain = 'robinhood' AND stream = 'live'"
    );
    assert.deepEqual(
      (await repository.loadSwapFrontier()).reason,
      'swap_live_frontier_unproven'
    );
  });
});
