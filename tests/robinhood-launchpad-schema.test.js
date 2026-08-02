const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage97 = require('../src/utils/db-init-stage97');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

it('adds and guards durable catalog launchpad attribution', () => {
  const sql = stage97.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find((entry) => (
    entry.key === 'stage97-catalog-launchpad-attribution'
  ));

  assert.match(sql, /ADD COLUMN IF NOT EXISTS launchpad_id VARCHAR\(32\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS launchpad_checked_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage97.js');
  assert.deepEqual(group.tables[0].columns, ['launchpad_id', 'launchpad_checked_at']);
  assert.ok(getGroupsForProfile('test').some((entry) => entry.key === group.key));
});
