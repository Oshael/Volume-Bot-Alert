'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { STATEMENTS, init } = require('../src/utils/db-init-stage205');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood canonical capture recovery fence schema', () => {
  it('requires a durable plan whenever capture is fenced', () => {
    const sql = STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS generation BIGINT/);
    assert.match(sql, /recovery_state VARCHAR\(24\)/);
    assert.match(sql, /recovery_state IN \('running', 'recovery_required'\)/);
    assert.match(sql, /jsonb_typeof\(recovery_plan\) = 'object'/);
    assert.match(sql, /recovery_detected_at IS NOT NULL/);
  });

  it('runs sequentially and is registered in the runtime schema guard', async () => {
    const calls = [];
    await init({
      database: { query: async (sql) => calls.push(sql) },
      closePool: false,
    });
    assert.deepEqual(calls, STATEMENTS);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage205-robinhood-capture-recovery-fence'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage205.js');
    assert.deepEqual(group.tables[0].columns, [
      'generation', 'recovery_state', 'recovery_plan', 'recovery_detected_at',
    ]);
  });
});
