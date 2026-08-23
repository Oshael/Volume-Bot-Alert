const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage156 = require('../src/utils/db-init-stage156');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('declares the token-scoped first-pool origin index', () => {
  assert.match(stage156.CREATE_STATEMENT, /CREATE INDEX CONCURRENTLY/);
  assert.match(stage156.CREATE_STATEMENT,
    /robinhood_pool_registry \(chain, token_address, discovery_block\)/);
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage156-robinhood-pool-token-origin-index'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage156.js');
  assert.equal(group.tables[0].indexes[0].name, stage156.INDEX_NAME);
});
