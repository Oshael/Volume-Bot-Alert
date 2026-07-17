const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage76 = require('../src/utils/db-init-stage76');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

describe('custom alert capability schema', () => {
  it('adds FDV and canonical spot storage without changing rule state', () => {
    const sql = stage76.STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS "window" VARCHAR\(16\) DEFAULT 'spot'/);
    assert.match(sql, /SET "window" = 'spot'/);
    assert.match(sql, /ALTER COLUMN "window" SET NOT NULL/);
    assert.match(sql, /CHECK \(metric IN \('price', 'mcap', 'fdv'\)\)/);
    assert.match(sql, /CHECK \("window" IN \('spot'\)\)/);
    assert.doesNotMatch(sql, /UPDATE[\s\S]*SET\s+(?:status|triggered_at)\s*=/i);
    assert.doesNotMatch(sql, /DROP\s+(?:COLUMN|TABLE)/i);
  });

  it('registers the migration and both constraints in runtime schema', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage76-custom-alert-capabilities'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage76.js');
    assert.deepEqual(group.tables[0].columns, ['window']);
    assert.deepEqual(
      group.tables[0].constraints.map((constraint) => constraint.name),
      ['user_custom_alert_rules_metric_check', 'user_custom_alert_rules_window_check'],
    );
    assert.ok(getGroupsForProfile('test').includes(group));
  });
});
