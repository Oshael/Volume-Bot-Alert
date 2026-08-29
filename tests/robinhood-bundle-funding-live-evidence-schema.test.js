const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage173 = require('../src/utils/db-init-stage173');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers versioned token-scoped live funding evidence', () => {
  const sql = stage173.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage173-robinhood-bundle-funding-live-evidence'
  ));
  assert.match(sql, /queue_version, candidate_wallet, transaction_hash, hop/);
  assert.match(sql, /FOREIGN KEY \(\s*chain, token_address/s);
  assert.match(sql, /hop = 1 AND to_wallet = candidate_wallet/);
  assert.equal(group.repair, 'node src/utils/db-init-stage173.js');
});
