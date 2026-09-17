const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage231 = require('../src/utils/db-init-stage231');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('defines nullable fail-closed Robinhood holder tail coverage without an index', () => {
  const sql = stage231.STATEMENTS.join('\n');
  for (const pattern of [
    /ADD COLUMN IF NOT EXISTS tail_capture_from_block BIGINT/,
    /tail_capture_from_block IS NULL OR/,
    /tail_capture_from_block >= deployment_block/,
    /backfill_next_block >= deployment_block/,
    /ledger_status NOT IN \('shadow', 'live'\)/,
    /live_through_block >= tail_capture_from_block - 1/,
    /NOT VALID/, /VALIDATE CONSTRAINT/,
  ]) assert.match(sql, pattern);
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage231-robinhood-holder-tail-coverage');
  assert.equal(group.repair, 'node src/utils/db-init-stage231.js');
  assert.deepEqual(group.tables[0].columns, ['tail_capture_from_block']);
  assert.equal(group.tables[0].constraints[0].name, stage231.CONSTRAINT_NAME);
});
