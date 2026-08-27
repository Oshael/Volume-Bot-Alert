const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage169 = require('../src/utils/db-init-stage169');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds permanent token-scoped causal funding evidence', () => {
  const sql = stage169.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage169-robinhood-token-scoped-funding-evidence'
  ));
  assert.match(sql, /robinhood_bundle_funding_evidence/);
  assert.match(sql, /run_id, token_address, candidate_wallet/);
  assert.match(sql, /hop = 1 AND to_wallet = candidate_wallet/);
  assert.match(sql, /hop = 2/);
  assert.match(sql, /value_wei > 0/);
  assert.doesNotMatch(sql, /INSERT INTO|\bUPDATE\b|DELETE FROM/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage169.js');
});
