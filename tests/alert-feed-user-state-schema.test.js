const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage77 = require('../src/utils/db-init-stage77');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

describe('alert feed user state schema', () => {
  it('promotes cursor identity to user, rule, and chain without replaying custom alerts', () => {
    const sql = stage77.STATEMENTS.join('\n');

    assert.match(sql, /ADD COLUMN IF NOT EXISTS chain VARCHAR\(32\) DEFAULT 'solana'/);
    assert.match(sql, /PRIMARY KEY \(user_id, rule_key, chain\)/);
    assert.match(sql, /source\.rule_key = 'custom-alert'/);
    assert.match(sql, /'robinhood'/);
    assert.match(sql, /target\.chain = 'robinhood'/);
    assert.match(sql, /rule_key = 'robinhood-hvnc-v2'/);
    assert.doesNotMatch(sql, /DROP\s+(?:COLUMN|TABLE)/i);
  });

  it('creates chain-scoped persistent event dismissals', () => {
    const sql = stage77.STATEMENTS.join('\n');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS alert_event_dismissals/);
    assert.match(sql, /PRIMARY KEY \(user_id, rule_key, chain, event_id\)/);
    assert.match(sql, /CHECK \(event_id > 0\)/);
    assert.match(sql, /REFERENCES users\(id\) ON DELETE CASCADE/);
  });

  it('registers both structures in runtime and test schema profiles', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage77-chain-scoped-alert-state'
    ));

    assert.equal(group.repair, 'node src/utils/db-init-stage77.js');
    assert.deepEqual(
      group.tables.map((table) => table.table),
      ['alert_delivery_cursors', 'alert_event_dismissals'],
    );
    assert.ok(getGroupsForProfile('test').includes(group));
  });
});
