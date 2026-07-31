const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stateModel = require('../src/models/telegram-alert-rule-state');
const stage88 = require('../src/utils/db-init-stage88');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

describe('Telegram alert rule state', () => {
  it('defines destination-specific state ownership and optimistic versions', () => {
    const sql = stage88.STATEMENTS.join('\n');
    assert.match(sql, /PRIMARY KEY \(profile_id, rule_key, token_address\)/);
    assert.match(
      sql,
      /FOREIGN KEY \(profile_id, chain\)[\s\S]+REFERENCES telegram_alert_profiles/
    );
    assert.match(
      sql,
      /FOREIGN KEY \(profile_id, rule_key\)[\s\S]+REFERENCES telegram_alert_rule_settings/
    );
    assert.match(sql, /jsonb_typeof\(state_json\) = 'object'/);
    assert.match(sql, /rule_version > 0/);
    assert.match(sql, /version > 0/);
  });

  it('registers the table in runtime and test schema guards', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage88-telegram-alert-rule-state'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage88.js');
    assert.deepEqual(group.tables[0].columns, [
      'profile_id', 'chain', 'rule_key', 'token_address', 'rule_version',
      'state_json', 'version', 'created_at', 'updated_at',
    ]);
    assert.ok(getGroupsForProfile('test').includes(group));
  });

  it('locks one normalized state identity for transactional evaluation', async () => {
    const db = fakeDb([{
      profile_id: '9007199254740993',
      chain: 'robinhood',
      rule_key: 'monitored-fdv',
      token_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      rule_version: 4,
      state_json: { status: 'armed' },
      version: 6,
    }]);

    const result = await stateModel.findForUpdate({
      profileId: '9007199254740993',
      chain: 'robinhood',
      ruleKey: 'monitored-fdv',
      tokenAddress: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    }, db);

    assert.match(db.calls[0].sql, /FOR UPDATE$/);
    assert.deepEqual(db.calls[0].params, [
      '9007199254740993',
      'robinhood',
      'monitored-fdv',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    ]);
    assert.equal(result.profileId, '9007199254740993');
    assert.equal(result.state.status, 'armed');

    await stateModel.listByProfileAndToken({
      profileId: '9007199254740993',
      chain: 'robinhood',
      tokenAddress: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      ruleKeys: ['monitored-fdv'],
    }, db);
    assert.match(db.calls[1].sql, /rule_key = ANY\(\$4::varchar\[\]\)/);
    assert.deepEqual(db.calls[1].params, [
      '9007199254740993',
      'robinhood',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ['monitored-fdv'],
    ]);
  });

  it('inserts once and updates only at the expected state version', async () => {
    const db = fakeDb([{
      profile_id: '10',
      chain: 'solana',
      rule_key: 'monitored-vol',
      token_address: '11111111111111111111111111111111',
      rule_version: 3,
      state_json: { status: 'triggered', dedupeKey: 'signal:1' },
      version: 1,
    }]);

    await stateModel.write({
      profileId: 10,
      chain: 'solana',
      ruleKey: 'monitored-vol',
      tokenAddress: '11111111111111111111111111111111',
      ruleVersion: 3,
      state: { status: 'triggered', dedupeKey: 'signal:1' },
      expectedVersion: null,
    }, db);

    assert.match(db.calls[0].sql, /ON CONFLICT \(profile_id, rule_key, token_address\)/);
    assert.match(db.calls[0].sql, /telegram_alert_rule_states\.version = \$7/);
    assert.deepEqual(db.calls[0].params, [
      '10',
      'solana',
      'monitored-vol',
      '11111111111111111111111111111111',
      3,
      '{"status":"triggered","dedupeKey":"signal:1"}',
      null,
    ]);
  });

  it('returns null on an optimistic conflict and rejects unsupported rules', async () => {
    const db = fakeDb();
    const conflict = await stateModel.write({
      profileId: 10,
      chain: 'solana',
      ruleKey: 'monitored-vol',
      tokenAddress: '11111111111111111111111111111111',
      ruleVersion: 3,
      state: { status: 'rearmed' },
      expectedVersion: 8,
    }, db);
    assert.equal(conflict, null);

    await assert.rejects(
      () => stateModel.write({
        profileId: 10,
        chain: 'solana',
        ruleKey: 'claim',
        tokenAddress: '11111111111111111111111111111111',
        ruleVersion: 1,
        state: {},
      }, db),
      /Unsupported Telegram alert rule/
    );
  });
});
