const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage134 = require('../src/utils/db-init-stage134');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-transfer cursor origin schema', () => {
  it('adds a nullable monotonic origin without inferring existing history', () => {
    const sql = stage134.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage134-robinhood-wallet-transfer-cursor-origins'
    ));
    assert.match(sql, /ADD COLUMN IF NOT EXISTS origin_block BIGINT/);
    assert.match(sql, /origin_block IS NULL/);
    assert.match(sql, /origin_block <= next_block/);
    assert.doesNotMatch(sql, /UPDATE robinhood_wallet_transfer_cursors/);
    assert.equal(group.repair, 'node src/utils/db-init-stage134.js');
  });
});
