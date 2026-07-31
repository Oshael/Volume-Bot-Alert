const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage85 = require('../src/utils/db-init-stage85');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

const sql = stage85.STATEMENTS.join('\n');

describe('Telegram alert profile schema', () => {
  it('keeps profiles independent by user and chain while binding ownership', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_alert_profiles/);
    assert.match(
      sql,
      /FOREIGN KEY \(connection_id, user_id\)[\s\S]+REFERENCES telegram_connections\(id, user_id\)/
    );
    assert.match(sql, /UNIQUE \(user_id, chain\)/);
    assert.match(sql, /CHECK \(chain IN \('solana', 'robinhood'\)\)/);
  });

  it('enforces chain-specific rule keys and excludes unsupported alert families', () => {
    assert.match(
      sql,
      /chain = 'solana'[\s\S]+monitored-mcap[\s\S]+meteora-surge/
    );
    assert.match(
      sql,
      /chain = 'robinhood'[\s\S]+monitored-fdv[\s\S]+robinhood-hvnc-v2/
    );
    assert.doesNotMatch(sql, /gmgn-claim-signal|pump-claim|bags-claim|custom-alert/);
  });

  it('requires object settings and positive optimistic versions', () => {
    assert.match(sql, /jsonb_typeof\(settings_json\) = 'object'/);
    assert.match(sql, /telegram_alert_profiles_version_check CHECK \(version > 0\)/);
    assert.match(sql, /telegram_alert_rule_settings_version_check CHECK \(version > 0\)/);
    assert.match(sql, /UNIQUE \(profile_id, rule_key\)/);
  });

  it('registers the profile schema in runtime and test guards', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage85-telegram-alert-profiles'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage85.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'telegram_connections',
      'telegram_alert_profiles',
      'telegram_alert_rule_settings',
    ]);
    assert.ok(getGroupsForProfile('test').includes(group));
  });
});
