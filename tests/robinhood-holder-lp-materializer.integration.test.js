process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderLpMaterializer,
} = require('../src/services/robinhood-holder-lp-materializer');
const stage63 = require('../src/utils/db-init-stage63');
const stage116 = require('../src/utils/db-init-stage116');
const stage143 = require('../src/utils/db-init-stage143');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'b'.repeat(40)}`;
const POOL = `0x${'c'.repeat(40)}`;
const FUTURE_POOL = `0x${'d'.repeat(40)}`;
const MANAGER = `0x${'e'.repeat(40)}`;
const QUOTE = `0x${'f'.repeat(40)}`;
const HASH = `0x${'1'.repeat(64)}`;
const TX = `0x${'2'.repeat(64)}`;
const POOL_ID = `0x${'3'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_holder_classifications WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_classification_states WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
}

async function insertPool({ protocol, marketKey, poolAddress, poolId, originAddress, block }) {
  await db.query(
    `INSERT INTO robinhood_pool_registry (
       chain, protocol, market_key, pool_address, pool_id, origin_address,
       token_address, quote_address, currency0, currency1, discovery_block,
       discovery_block_hash, discovery_tx_hash, discovery_log_index, discovered_at
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $7, $6, $7,
       $8, $9, $10, 1, '2026-08-21T12:00:00Z')`,
    [protocol, marketKey, poolAddress, poolId, originAddress, TOKEN, QUOTE, block, HASH, TX]
  );
}

describe('Robinhood holder LP materializer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage143.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         chain, token_address, ledger_status, live_through_block, live_through_hash
       ) VALUES ('robinhood', $1, 'live', 100, $2)`,
      [TOKEN, HASH]
    );
    await insertPool({
      protocol: 'uniswap-v2', marketKey: 'test-lp-current', poolAddress: POOL,
      poolId: null, originAddress: null, block: 90,
    });
    await insertPool({
      protocol: 'uniswap-v3', marketKey: 'test-lp-future', poolAddress: FUTURE_POOL,
      poolId: null, originAddress: null, block: 110,
    });
    await insertPool({
      protocol: 'uniswap-v4', marketKey: 'test-lp-v4', poolAddress: null,
      poolId: POOL_ID, originAddress: MANAGER, block: 80,
    });
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('publishes only address-bearing pools visible at the canonical holder frontier', async () => {
    const materializer = createRobinhoodHolderLpMaterializer({
      database: db, now: () => '2026-08-21T13:00:00Z',
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'published', records: 1,
    });
    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'unchanged', records: 1,
    });
    const stored = await db.query(
      `SELECT wallet_address, reason_code, through_block_number::text
         FROM robinhood_holder_classifications
        WHERE token_address = $1 AND tag = 'lp'`,
      [TOKEN]
    );
    assert.deepEqual(stored.rows, [{
      wallet_address: POOL,
      reason_code: 'registered_token_pool',
      through_block_number: '100',
    }]);
    assert.equal(stored.rows.some((row) => row.wallet_address === MANAGER), false);
    assert.equal(stored.rows.some((row) => row.wallet_address === FUTURE_POOL), false);
  });
});
