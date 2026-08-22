const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage149 = require('../src/utils/db-init-stage149');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-token first buy schema', () => {
  it('keeps classification out of the reusable canonical evidence', () => {
    const sql = stage149.STATEMENTS.join('\n');
    assert.match(sql, /PRIMARY KEY \(chain, token_address, wallet_address\)/);
    assert.match(sql, /transaction_index INTEGER NOT NULL/);
    assert.match(sql, /REFERENCES robinhood_pool_registry/);
    assert.doesNotMatch(sql, /buyer_rank|confidence|sniper/);
  });

  it('registers token-order and cross-token recurrence access paths', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage149-robinhood-wallet-token-first-buys'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage149.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), [
      'idx_rh_wallet_token_first_buys_token_order',
      'idx_rh_wallet_token_first_buys_wallet_recurrence',
    ]);
  });
});
