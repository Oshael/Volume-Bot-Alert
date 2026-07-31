const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage89 = require('../src/utils/db-init-stage89');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

const sql = stage89.STATEMENTS.join('\n');

describe('Telegram alert delivery outbox schema', () => {
  it('binds each delivery to one connection, profile and supported rule', () => {
    assert.match(
      sql,
      /FOREIGN KEY \(profile_id, connection_id, chain\)[\s\S]+REFERENCES telegram_alert_profiles/
    );
    assert.match(
      sql,
      /FOREIGN KEY \(profile_id, rule_key\)[\s\S]+REFERENCES telegram_alert_rule_settings/
    );
    assert.match(sql, /UNIQUE \(connection_id, dedupe_key\)/);
    assert.match(sql, /chain IN \('solana', 'robinhood'\)/);
    assert.match(sql, /jsonb_typeof\(event_payload\) = 'object'/);
  });

  it('protects the delivery lifecycle and lease invariants', () => {
    assert.match(
      sql,
      /status IN \('pending', 'claimed', 'retry', 'sent', 'cancelled', 'failed'\)/
    );
    assert.match(sql, /attempts >= 0/);
    assert.match(
      sql,
      /status = 'claimed' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL/
    );
    assert.match(sql, /\(status = 'sent'\) = \(delivered_at IS NOT NULL\)/);
    assert.match(sql, /telegram_message_id IS NULL OR telegram_message_id > 0/);
  });

  it('indexes ready work, expired claims and profile history', () => {
    assert.match(
      sql,
      /idx_telegram_alert_deliveries_ready[\s\S]+WHERE status IN \('pending', 'retry'\)/
    );
    assert.match(
      sql,
      /idx_telegram_alert_deliveries_claimed_lease[\s\S]+WHERE status = 'claimed'/
    );
    assert.match(
      sql,
      /idx_telegram_alert_deliveries_profile_history[\s\S]+profile_id, triggered_at DESC/
    );
  });

  it('registers stage 89 in runtime and test schema guards', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage89-telegram-alert-delivery-outbox'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage89.js');
    assert.deepEqual(group.tables[1].columns, [
      'id', 'connection_id', 'profile_id', 'rule_key', 'chain', 'token_address',
      'dedupe_key', 'event_payload', 'triggered_at', 'status', 'attempts',
      'next_attempt_at', 'lease_owner', 'lease_until', 'telegram_message_id',
      'telegram_file_id', 'last_error_code', 'last_error', 'delivered_at',
      'created_at', 'updated_at',
    ]);
    const constraints = new Set(
      group.tables[1].constraints.map(({ name }) => name)
    );
    assert.ok(constraints.has('telegram_alert_deliveries_chain_check'));
    assert.ok(constraints.has('telegram_alert_deliveries_address_check'));
    assert.ok(constraints.has('telegram_alert_deliveries_dedupe_check'));
    assert.ok(constraints.has('telegram_alert_deliveries_message_check'));
    assert.ok(getGroupsForProfile('test').includes(group));
  });
});
