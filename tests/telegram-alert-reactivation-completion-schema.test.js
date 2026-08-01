const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage94 = require('../src/utils/db-init-stage94');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const sql = stage94.STATEMENTS.join('\n');

describe('Telegram access reactivation completion schema', () => {
  it('retains a durable epoch while excluding disconnected links', () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS access_reactivated_at/);
    assert.match(sql, /date_trunc\([\s\S]*'milliseconds'/);
    assert.match(sql, /telegram_connections_reactivated_check/);
    assert.match(sql, /access_reactivated_at IS NULL OR status <> 'disconnected'/);
  });

  it('registers the epoch in runtime schema validation', () => {
    const group = SCHEMA_GROUPS.find(
      ({ key }) => key === 'stage94-telegram-access-reactivation-epoch',
    );
    assert.equal(group.repair, 'node src/utils/db-init-stage94.js');
    assert.deepEqual(group.tables[0].columns, ['access_reactivated_at']);
    assert.equal(
      group.tables[0].constraints[0].name,
      'telegram_connections_reactivated_check',
    );
  });
});
