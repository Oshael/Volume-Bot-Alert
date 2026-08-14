const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage129 = require('../src/utils/db-init-stage129');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet transfer projection schema', () => {
  it('keeps edges and cursors versioned and evidence slots bounded', () => {
    const sql = stage129.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage129-robinhood-wallet-transfer-projection'
    ));

    assert.match(sql, /PRIMARY KEY \(\s*chain, classification_version, token_address/);
    assert.match(sql, /evidence_role IN \('first', 'largest', 'last', 'temporal'\)/);
    assert.match(sql, /CREATE UNIQUE INDEX[^;]*idx_rh_wallet_relationship_evidence_slot/s);
    assert.match(sql, /PRIMARY KEY \(\s*chain, projection_version, stream/);
    assert.match(sql, /lifecycle_state IN \('pending', 'running', 'complete', 'failed'\)/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage129.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_wallet_transfer_edges',
      'robinhood_wallet_relationship_evidence',
      'robinhood_wallet_transfer_cursors',
    ]);
  });
});
