const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage153 = require('../src/utils/db-init-stage153');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood directional wallet-transfer evidence schema', () => {
  it('adds nullable evidence without launching an unbounded migration backfill', () => {
    const sql = stage153.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage153-robinhood-directional-wallet-transfer-evidence'
    ));

    assert.match(sql, /first_wallet_transfer_block IS NULL/);
    assert.match(sql, /first_wallet_transfer_transaction_hash ~ '\^0x\[0-9a-f\]\{64\}\$'/);
    assert.doesNotMatch(sql, /UPDATE|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage153.js');
  });
});
