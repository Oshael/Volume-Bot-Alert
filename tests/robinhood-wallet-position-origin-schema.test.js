const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage137 = require('../src/utils/db-init-stage137');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-position cursor origin schema', () => {
  it('adds a nullable monotonic origin without inferring existing history', () => {
    const sql = stage137.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage137-robinhood-wallet-position-cursor-origins'
    ));
    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_block BIGINT/);
    assert.match(sql, /origin_block IS NULL/);
    assert.match(sql, /origin_block <= next_block/);
    assert.doesNotMatch(sql, /UPDATE robinhood_wallet_position_cursors/);
    assert.equal(group.repair, 'node src/utils/db-init-stage137.js');
  });
});
