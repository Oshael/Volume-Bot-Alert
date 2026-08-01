const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage95 = require('../src/utils/db-init-stage95');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

const sql = stage95.STATEMENTS.join('\n');

describe('Telegram language preference schema', () => {
  it('adds a bounded English-default language code', () => {
    assert.match(
      sql,
      /ADD COLUMN IF NOT EXISTS language_code VARCHAR\(35\) NOT NULL DEFAULT 'en'/,
    );
    assert.match(sql, /telegram_connections_language_code_check/);
    assert.match(sql, /CHAR_LENGTH\(language_code\) BETWEEN 2 AND 35/);
  });

  it('registers Stage 95 in runtime and test schema guards', () => {
    const group = SCHEMA_GROUPS.find(
      ({ key }) => key === 'stage95-telegram-language-preference',
    );
    assert.equal(group.repair, 'node src/utils/db-init-stage95.js');
    assert.deepEqual(group.tables[0].columns, ['language_code']);
    assert.ok(getGroupsForProfile('test').includes(group));
  });
});
