const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage136 = require('../src/utils/db-init-stage136');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet transfer reclassification schema', () => {
  it('preserves an immutable, versioned decision for every applied transition', () => {
    const sql = stage136.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage136-robinhood-wallet-transfer-reclassifications'
    ));
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_reclassifications/);
    assert.match(sql, /PRIMARY KEY[\s\S]*transaction_hash[\s\S]*to_classification_version/);
    assert.match(sql, /from_transfer_kind = 'unknown'/);
    assert.match(sql, /decision_evidence <> '\{\}'::jsonb/);
    assert.doesNotMatch(sql, /UPDATE|DELETE|DROP/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage136.js');
  });
});
