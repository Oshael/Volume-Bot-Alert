const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage130 = require('../src/utils/db-init-stage130');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet transfer frontier schema', () => {
  it('adds exact log frontiers without destructive SQL', () => {
    const sql = stage130.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage130-robinhood-wallet-transfer-edge-frontiers'
    ));

    for (const role of ['first', 'last', 'largest']) {
      assert.match(sql, new RegExp(`${role}_log_index`));
    }
    assert.match(sql, /cannot infer transfer edge log indexes/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage130.js');
  });
});
