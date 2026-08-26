process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage163 = require('../src/utils/db-init-stage163');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'6'.repeat(40)}`;
const CREATOR = `0x${'7'.repeat(40)}`;
const FACTORY = `0x${'8'.repeat(40)}`;
const HASH = `0x${'9'.repeat(64)}`;

describe('Robinhood RPC trace provenance schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage110.init({ closePool: false });
    await stage113.init({ closePool: false });
    await stage114.init({ closePool: false });
    await stage163.init({ closePool: false });
    await stage163.init({ closePool: false });
    await db.query('DELETE FROM robinhood_token_attributions WHERE token_address = $1', [TOKEN]);
  });

  after(async () => {
    await db.query('DELETE FROM robinhood_token_attributions WHERE token_address = $1', [TOKEN]);
    await db.pool.end();
  });

  it('accepts traced factory evidence and rejects it without the factory', async () => {
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, creator_address, source, attribution_block,
         attribution_tx_hash, attribution_factory_address, last_resolved_at
       ) VALUES ($1, $2, 'rpc_trace', 100, $3, $4, NOW())`,
      [TOKEN, CREATOR, HASH, FACTORY]
    );
    const result = await db.query(
      `SELECT source, attribution_factory_address
         FROM robinhood_token_attributions WHERE token_address = $1`, [TOKEN]
    );
    assert.deepEqual(result.rows[0], {
      source: 'rpc_trace', attribution_factory_address: FACTORY,
    });
    await assert.rejects(
      db.query(
        `UPDATE robinhood_token_attributions
            SET attribution_factory_address = NULL WHERE token_address = $1`, [TOKEN]
      ),
      /robinhood_token_attributions_provenance_check/
    );
  });
});
