process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderDevHoldMaterializer,
} = require('../src/services/robinhood-holder-dev-hold-materializer');
const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage116 = require('../src/utils/db-init-stage116');
const stage144 = require('../src/utils/db-init-stage144');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'8'.repeat(40)}`;
const NO_CREATOR = `0x${'9'.repeat(40)}`;
const CREATOR = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const HASH = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`;

async function cleanup() {
  const tokens = [TOKEN, NO_CREATOR];
  await db.query('DELETE FROM robinhood_holder_distribution_metrics WHERE token_address = ANY($1)', [tokens]);
  await db.query('DELETE FROM robinhood_holder_balances WHERE token_address = ANY($1)', [tokens]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = ANY($1)', [tokens]);
  await db.query('DELETE FROM robinhood_token_attributions WHERE token_address = ANY($1)', [tokens]);
}

describe('Robinhood DEV HOLD materializer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage110.init({ closePool: false });
    await stage113.init({ closePool: false });
    await stage114.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage144.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, holder_count, ledger_status, live_through_block, live_through_hash
       ) VALUES ($1, 2, 'live', 100, $3), ($2, 1, 'live', 100, $3)`,
      [TOKEN, NO_CREATOR, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, creator_address, source, last_resolved_at
       ) VALUES ($1, $2, 'blockscout', '2026-08-21T11:00:00Z')`,
      [TOKEN, CREATOR]
    );
    await db.query(
      `INSERT INTO robinhood_holder_balances (
         token_address, wallet_address, balance_raw, last_block_number,
         last_transaction_hash, last_log_index
       ) VALUES ($1, $2, 25, 100, $4, 1), ($1, $3, 75, 100, $4, 2),
                ($5, $3, 100, 100, $4, 1)`,
      [TOKEN, CREATOR, OTHER, TX, NO_CREATOR]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('publishes an exact ratio and never invents zero without a creator', async () => {
    const materializer = createRobinhoodHolderDevHoldMaterializer({
      database: db, now: () => '2026-08-21T12:00:00Z',
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), { status: 'published' });
    assert.deepEqual(await materializer.materializeToken(TOKEN), { status: 'unchanged' });
    assert.deepEqual(await materializer.materializeToken(NO_CREATOR), { status: 'published' });
    const result = await db.query(
      `SELECT token_address, status, status_reason, value_numerator_raw::text,
              value_denominator_raw::text, wallet_count::text, through_block_number::text
         FROM robinhood_holder_distribution_metrics
        WHERE token_address = ANY($1) AND metric = 'dev_hold' ORDER BY token_address`,
      [[TOKEN, NO_CREATOR]]
    );
    assert.deepEqual(result.rows, [{
      token_address: TOKEN, status: 'ready', status_reason: 'materialized',
      value_numerator_raw: '25', value_denominator_raw: '100',
      wallet_count: '1', through_block_number: '100',
    }, {
      token_address: NO_CREATOR, status: 'unavailable',
      status_reason: 'creator_unavailable', value_numerator_raw: null,
      value_denominator_raw: null, wallet_count: null, through_block_number: null,
    }]);
  });
});
