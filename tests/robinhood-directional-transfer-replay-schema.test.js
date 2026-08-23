const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage154 = require('../src/utils/db-init-stage154');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood directional transfer replay control schema', () => {
  it('adds bounded resumable control tables without starting a replay', () => {
    const sql = stage154.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage154-robinhood-directional-transfer-replay-control'
    ));

    assert.match(sql, /source_through_hash/);
    assert.match(sql, /range_blocks BETWEEN 1 AND 5000/);
    assert.match(sql, /FOR UPDATE|SKIP LOCKED|lease_owner|lease_until/);
    assert.match(sql, /completed_through_block = range_end_block/);
    assert.doesNotMatch(
      sql, /\bUPDATE\b|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i
    );
    assert.equal(group.repair, 'node src/utils/db-init-stage154.js');
  });
});
