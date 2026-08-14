process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletTransferLiveSourceRepository,
} = require('../src/models/robinhood-wallet-transfer-live-source');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage91 = require('../src/utils/db-init-stage91');
const stage116 = require('../src/utils/db-init-stage116');
const stage120 = require('../src/utils/db-init-stage120');
const stage122 = require('../src/utils/db-init-stage122');
const stage133 = require('../src/utils/db-init-stage133');
const stage129 = require('../src/utils/db-init-stage129');
const stage134 = require('../src/utils/db-init-stage134');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
const ROUTER = `0x${'4'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const PARTITION = 'robinhood_wallet_swaps_2099_02_01';

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_swaps WHERE transaction_hash = $1', [TX]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', ['test-transfer-source']);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query("DELETE FROM robinhood_wallet_swap_cursors WHERE chain = 'robinhood' AND stream IN ('seed', 'live')");
  await db.query("DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = 'test_transfer_plan_v1'");
}

describe('Robinhood wallet transfer LIVE source', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage63, stage90, stage91, stage116, stage120, stage122, stage133, stage129, stage134,
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
         $3, $2, $3, 1, $4, $5, 1, NOW())`,
      [POOL, TOKEN, ROUTER, HASH, TX]
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

    const repository = createRobinhoodWalletTransferLiveSourceRepository({ database: db });
    const frontier = await repository.loadSwapFrontier();
    const backfillFrontier = await repository.loadBackfillFrontier();
    const backfillPlan = await repository.loadBackfillPlan('test_transfer_plan_v1');
    const tokens = await repository.listTrackedTokenAddresses();
    const context = await repository.loadRangeContext({
      fromBlock: '100', toBlock: '119',
      transactionHashes: [TX], endpointAddresses: [WALLET, POOL, ROUTER],
      fromTime: '2099-02-01T00:00:00Z', toTime: '2099-02-01T23:59:59Z',
    });
    const backfillContext = await repository.loadBackfillRangeContext({
      fromBlock: '100', toBlock: '119',
      transactionHashes: [TX], endpointAddresses: [WALLET, POOL, ROUTER],
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
    assert.deepEqual(context.poolAddresses, [POOL]);
    assert.deepEqual(context.routerAddresses, [ROUTER]);
    assert.deepEqual(context.walletAddresses, [WALLET]);
    assert.equal(backfillContext.ready, true);
    assert.equal(backfillContext.swaps.length, 1);
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
