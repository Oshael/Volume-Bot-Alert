const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage174 = require('../src/utils/db-init-stage174');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('adds an explicit version to live possible-bundle lineage', () => {
  const sql = stage174.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage174-robinhood-possible-bundle-live-lineage'
  ));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_version BIGINT/);
  assert.match(sql, /source_kind = 'live'.*source_version >= 1/s);
  assert.equal(group.repair, 'node src/utils/db-init-stage174.js');
});
