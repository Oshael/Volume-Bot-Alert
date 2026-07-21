const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage80 = require('../src/utils/db-init-stage80');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

describe('Meteora scheduling index schema', () => {
  it('creates concurrent partial indexes for both eligibility paths', () => {
    const sql = stage80.STATEMENTS.join('\n');

    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_catalog_meteora_catalog_eligible/);
    assert.match(sql, /ON token_catalog\(id\)/);
    assert.match(sql, /COALESCE\(last_mcap, 0\) >= 100000/);
    assert.match(sql, /eligibility_state IN \('dex-low', 'dex-normal', 'dex-high'\)/);
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_meteora_state_active_pool_address/);
    assert.match(sql, /ON token_meteora_state\(token_address\)\s+WHERE has_pool = TRUE/);
  });

  it('registers the index in runtime and test schema profiles', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage80-meteora-eligibility-indexes'
    ));

    assert.equal(group.repair, 'node src/utils/db-init-stage80.js');
    assert.deepEqual(group.tables.flatMap((table) => table.indexes.map((index) => index.name)), [
      'idx_token_catalog_meteora_catalog_eligible',
      'idx_token_meteora_state_active_pool_address',
    ]);
    assert.ok(getGroupsForProfile('test').includes(group));
  });
});
