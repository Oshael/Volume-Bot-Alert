const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage93 = require('../src/utils/db-init-stage93');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const sql = stage93.STATEMENTS.join('\n');

describe('Telegram access reactivation marker schema', () => {
  it('keeps the durable marker exclusive to access suspension', () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS access_reactivation_requested_at/);
    assert.match(sql, /telegram_connections_reactivation_check/);
    assert.match(
      sql,
      /access_reactivation_requested_at IS NULL[\s\S]+status = 'access_suspended'/,
    );
  });

  it('registers the marker in runtime schema validation', () => {
    const group = SCHEMA_GROUPS.find(
      ({ key }) => key === 'stage93-telegram-access-reactivation-marker',
    );
    assert.equal(group.repair, 'node src/utils/db-init-stage93.js');
    assert.deepEqual(group.tables[0].columns, ['access_reactivation_requested_at']);
    assert.equal(
      group.tables[0].constraints[0].name,
      'telegram_connections_reactivation_check',
    );
  });
});
