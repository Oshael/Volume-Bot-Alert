const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage133 = require('../src/utils/db-init-stage133');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-swap cursor origin schema', () => {
  it('adds a nullable, monotonic origin without guessing existing history', () => {
    const sql = stage133.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage133-robinhood-wallet-swap-cursor-origins'
    ));

    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_block BIGINT/);
    assert.match(sql, /origin_block IS NULL/);
    assert.match(sql, /origin_block <= next_block/);
    assert.doesNotMatch(sql, /UPDATE robinhood_wallet_swap_cursors/);
    assert.equal(group.repair, 'node src/utils/db-init-stage133.js');
  });
});
