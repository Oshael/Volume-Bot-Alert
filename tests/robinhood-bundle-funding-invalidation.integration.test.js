process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage63 = require('../src/utils/db-init-stage63');
const stage149 = require('../src/utils/db-init-stage149');
const stage155 = require('../src/utils/db-init-stage155');
const stage172 = require('../src/utils/db-init-stage172');
const stage246 = require('../src/utils/db-init-stage246');
const { createRobinhoodBundleFundingLiveQueueRepository } = require(
  '../src/models/robinhood-bundle-funding-live-queue');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'4'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
const QUOTE = `0x${'5'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const MARKET = 'funding-invalidation-integration';

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address=$1', [TOKEN]);
  await db.query('DELETE FROM robinhood_bundle_funding_live_queue WHERE token_address=$1', [TOKEN]);
  await db.query('DELETE FROM robinhood_token_launch_anchors WHERE token_address=$1', [TOKEN]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key=$1', [MARKET]);
}

async function queueState() {
  const { rows } = await db.query(`SELECT status, requested_version::text,
      completed_version::text, lease_owner
    FROM robinhood_bundle_funding_live_queue WHERE token_address=$1`, [TOKEN]);
  return rows[0];
}

async function addBuy(walletDigit, transactionDigit, blockNumber) {
  await db.query(`INSERT INTO robinhood_wallet_token_first_buys(
      token_address, wallet_address, transaction_hash, transaction_index,
      action_index, block_number, block_hash, block_time, protocol, market_key,
      source_parser_version
    ) VALUES ($1, $2, $3, 0, 0, $4, $5, NOW(), 'uniswap-v2', $6, 'test-v1')`,
  [TOKEN, `0x${walletDigit.repeat(40)}`, `0x${transactionDigit.repeat(64)}`,
    blockNumber, HASH, MARKET]);
}

before(async () => {
  await assertUsingTestDatabase(db);
  for (const stage of [stage63, stage149, stage155, stage172, stage246]) {
    await stage.init({ closePool: false, database: db });
  }
  await cleanup();
});

after(async () => {
  await cleanup();
  await db.pool.end();
});

it('keeps completed funding stable across late frontier updates and fences early buy changes',
  async () => {
    await db.query(`INSERT INTO robinhood_pool_registry(
        protocol, market_key, pool_address, token_address, quote_address,
        currency0, currency1, discovery_block, discovery_block_hash,
        discovery_tx_hash, discovery_log_index, discovered_at
      ) VALUES ('uniswap-v2', $1, $2, $3, $4, $3, $4, 90, $5, $5, 0, NOW())`,
    [MARKET, POOL, TOKEN, QUOTE, HASH]);
    await db.query(`INSERT INTO robinhood_token_launch_anchors(
        token_address, first_pool_block, launch_block, source_through_block
      ) VALUES ($1, 90, 100, 101)`, [TOKEN]);
    await db.query(`UPDATE robinhood_bundle_funding_live_queue SET
        status='complete', completed_version=requested_version, completed_at=NOW()
      WHERE token_address=$1`, [TOKEN]);

    await db.query(`UPDATE robinhood_token_launch_anchors
      SET source_through_block=103 WHERE token_address=$1`, [TOKEN]);
    assert.equal((await queueState()).requested_version, '2');
    await db.query(`UPDATE robinhood_bundle_funding_live_queue SET
        status='complete', completed_version=requested_version, completed_at=NOW()
      WHERE token_address=$1`, [TOKEN]);

    await db.query(`UPDATE robinhood_token_launch_anchors
      SET source_through_block=200 WHERE token_address=$1`, [TOKEN]);
    await db.query(`UPDATE robinhood_token_launch_anchors
      SET source_through_block=201 WHERE token_address=$1`, [TOKEN]);
    assert.deepEqual(await queueState(), {
      status: 'complete', requested_version: '2', completed_version: '2', lease_owner: null,
    });

    await addBuy('6', 'b', 105);
    assert.equal((await queueState()).requested_version, '2');
    await addBuy('7', 'c', 102);
    assert.deepEqual(await queueState(), {
      status: 'pending', requested_version: '3', completed_version: '2', lease_owner: null,
    });

    await db.query(`UPDATE robinhood_bundle_funding_live_queue SET
        status='leased', lease_owner='test-invalidation',
        lease_until=NOW()+INTERVAL '1 minute'
      WHERE token_address=$1`, [TOKEN]);
    await addBuy('8', 'd', 103);
    assert.deepEqual(await queueState(), {
      status: 'pending', requested_version: '4', completed_version: '2', lease_owner: null,
    });
    const queue = createRobinhoodBundleFundingLiveQueueRepository({ database: db });
    assert.equal(await queue.complete({ tokenAddress: TOKEN, owner: 'test-invalidation',
      requestedVersion: '3' }), false);

    await db.query(`UPDATE robinhood_token_launch_anchors
      SET launch_block=101 WHERE token_address=$1`, [TOKEN]);
    assert.equal((await queueState()).requested_version, '5');

    await db.query(`DELETE FROM robinhood_wallet_token_first_buys
      WHERE token_address=$1 AND wallet_address=$2`, [TOKEN, `0x${'7'.repeat(40)}`]);
    assert.equal((await queueState()).requested_version, '6');
  });
