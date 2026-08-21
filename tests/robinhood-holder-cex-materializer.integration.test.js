process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderCexMaterializer,
} = require('../src/services/robinhood-holder-cex-materializer');
const stage116 = require('../src/utils/db-init-stage116');
const stage143 = require('../src/utils/db-init-stage143');
const stage145 = require('../src/utils/db-init-stage145');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'b'.repeat(40)}`;
const ACTIVE_CEX = `0x${'c'.repeat(40)}`;
const HISTORICAL_CEX = `0x${'d'.repeat(40)}`;
const FUTURE_CEX = `0x${'e'.repeat(40)}`;
const ROUTER = `0x${'f'.repeat(40)}`;
const HASH_100 = `0x${'1'.repeat(64)}`;
const HASH_105 = `0x${'2'.repeat(64)}`;
const TX = `0x${'3'.repeat(64)}`;
const WALLETS = [ACTIVE_CEX, HISTORICAL_CEX, FUTURE_CEX, ROUTER];

async function cleanup() {
  await db.query('DELETE FROM robinhood_holder_classifications WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_classification_states WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_balances WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query(
    'DELETE FROM robinhood_infrastructure_registry WHERE address = ANY($1)', [WALLETS]
  );
}

async function insertRegistry(address, kind, from, through = null) {
  await db.query(
    `INSERT INTO robinhood_infrastructure_registry (
       address, kind, label, source, evidence_json, valid_from_block,
       valid_through_block, verified_at
     ) VALUES ($1, $2, $3, 'integration_fixture', '{"caseId":"cex-test"}',
       $4, $5, '2026-08-21T12:00:00Z')`,
    [address, kind, `${kind} fixture`, from, through]
  );
}

describe('Robinhood holder CEX materializer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage116.init({ closePool: false });
    await stage143.init({ closePool: false });
    await stage145.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, holder_count, ledger_status, live_through_block, live_through_hash
       ) VALUES ($1, 4, 'live', 100, $2)`,
      [TOKEN, HASH_100]
    );
    await db.query(
      `INSERT INTO robinhood_holder_balances (
         token_address, wallet_address, balance_raw, last_block_number,
         last_transaction_hash, last_log_index
       ) SELECT $1, wallet, 1, 100, $2, ordinal
           FROM UNNEST($3::varchar[]) WITH ORDINALITY AS item(wallet, ordinal)`,
      [TOKEN, TX, WALLETS]
    );
    await insertRegistry(ACTIVE_CEX, 'cex', 90);
    await insertRegistry(HISTORICAL_CEX, 'cex', 1, 99);
    await insertRegistry(FUTURE_CEX, 'cex', 101);
    await insertRegistry(ROUTER, 'router', 1);
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('publishes only CEX holders valid at the live ledger frontier', async () => {
    const materializer = createRobinhoodHolderCexMaterializer({
      database: db, now: () => '2026-08-21T13:00:00Z',
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'published', records: 1,
    });
    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'unchanged', records: 1,
    });
    let stored = await db.query(
      `SELECT wallet_address, reason_code, evidence_json, through_block_number::text
         FROM robinhood_holder_classifications
        WHERE token_address = $1 AND tag = 'cex' ORDER BY wallet_address`,
      [TOKEN]
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].wallet_address, ACTIVE_CEX);
    assert.equal(stored.rows[0].reason_code, 'known_cex_address');
    assert.equal(stored.rows[0].through_block_number, '100');
    assert.equal(stored.rows[0].evidence_json.registry.source, 'integration_fixture');

    await db.query(
      `UPDATE robinhood_holder_token_states SET live_through_block = 105,
         live_through_hash = $2 WHERE token_address = $1`,
      [TOKEN, HASH_105]
    );
    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'published', records: 2,
    });
    stored = await db.query(
      `SELECT wallet_address FROM robinhood_holder_classifications
        WHERE token_address = $1 AND tag = 'cex' ORDER BY wallet_address`,
      [TOKEN]
    );
    assert.deepEqual(stored.rows.map(({ wallet_address: wallet }) => wallet), [
      ACTIVE_CEX, FUTURE_CEX,
    ]);
  });
});
