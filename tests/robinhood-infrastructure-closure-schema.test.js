const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage146 = require('../src/utils/db-init-stage146');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood infrastructure closure schema', () => {
  it('defines optional but coherent audited closure metadata', () => {
    const sql = stage146.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage146-robinhood-infrastructure-closure'
    ));

    assert.match(sql, /ADD COLUMN IF NOT EXISTS closed_source/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS closed_evidence_json JSONB/);
    assert.match(sql, /jsonb_typeof\(closed_evidence_json\) = 'object'/);
    assert.match(sql, /valid_through_block IS NOT NULL/);
    assert.doesNotMatch(sql, /UPDATE\s+|DELETE\s+FROM|DROP\s+/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage146.js');
    assert.deepEqual(group.tables[0].columns, [
      'closed_source', 'closed_evidence_json', 'closed_verified_at',
    ]);
  });
});
