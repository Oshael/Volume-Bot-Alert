const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const connection = require('../src/models/telegram-connection');
const inputSession = require('../src/models/telegram-input-session');
const linkToken = require('../src/models/telegram-link-token');
const update = require('../src/models/telegram-update');
const stage84 = require('../src/utils/db-init-stage84');
const stage86 = require('../src/utils/db-init-stage86');
const stage87 = require('../src/utils/db-init-stage87');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

function fakeDb(result = { rows: [{}], rowCount: 1 }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return result;
    },
  };
}

describe('Telegram integration foundation', () => {
  it('defines private-link identities, one-time tokens, and update dedupe', () => {
    const sql = stage84.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_connections/);
    assert.match(sql, /telegram_user_id BIGINT NOT NULL/);
    assert.match(sql, /CHECK \(telegram_user_id > 0 AND chat_id > 0\)/);
    assert.match(sql, /UNIQUE INDEX[\s\S]+active_telegram_user[\s\S]+status <> 'disconnected'/);
    assert.match(sql, /token_hash CHAR\(64\) NOT NULL UNIQUE/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_updates/);
    assert.match(sql, /update_id BIGINT PRIMARY KEY/);
  });

  it('registers all tables in runtime and test schema guards', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage84-telegram-integration-foundation'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage84.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'telegram_connections', 'telegram_link_tokens', 'telegram_updates',
    ]);
    assert.ok(getGroupsForProfile('test').includes(group));
  });

  it('adds positive connection versions to runtime and test schema guards', () => {
    const sql = stage86.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage86-telegram-connection-versioning'
    ));

    assert.match(sql, /ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1/);
    assert.match(sql, /telegram_connections_version_check CHECK \(version > 0\)/);
    assert.equal(group.repair, 'node src/utils/db-init-stage86.js');
    assert.deepEqual(group.tables[0].columns, ['version']);
    assert.ok(getGroupsForProfile('test').includes(group));
  });

  it('registers durable, expiring input sessions in runtime and test guards', () => {
    const sql = stage87.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage87-telegram-input-sessions'
    ));

    assert.match(sql, /telegram_user_id BIGINT PRIMARY KEY/);
    assert.match(sql, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(sql, /CHECK \(action IN \('edit_rule_setting'\)\)/);
    assert.match(sql, /jsonb_typeof\(payload_json\) = 'object'/);
    assert.equal(group.repair, 'node src/utils/db-init-stage87.js');
    assert.ok(getGroupsForProfile('test').includes(group));
  });

  it('atomically replaces and reads sessions only for their current owner', async () => {
    const db = fakeDb({ rows: [{ action: 'edit_rule_setting' }], rowCount: 1 });
    await inputSession.replace({
      telegramUserId: 123n,
      userId: 7,
      action: 'edit_rule_setting',
      payload: { chain: 'solana', field: 'thresholdPct' },
      expiresAt: '2026-07-29T15:10:00.000Z',
    }, db);
    await inputSession.findActive({ telegramUserId: 123n, userId: 7 }, db);
    await inputSession.clear({ telegramUserId: 123n, userId: 7 }, db);

    assert.match(db.calls[0].sql, /ON CONFLICT \(telegram_user_id\) DO UPDATE/);
    assert.equal(db.calls[0].params[0], '123');
    assert.match(db.calls[1].sql, /user_id = \$2[\s\S]*expires_at > NOW\(\)/);
    assert.deepEqual(db.calls[1].params, ['123', 7]);
    assert.match(db.calls[2].sql, /DELETE FROM telegram_input_sessions/);
    assert.deepEqual(db.calls[2].params, ['123', 7]);
  });

  it('stores only a token hash and consumes it atomically once', async () => {
    const db = fakeDb({ rows: [{ id: 1 }], rowCount: 1 });
    const rawToken = 'raw-deep-link-secret';
    const created = await linkToken.create({
      userId: 7,
      expiresAt: '2026-07-29T15:00:00.000Z',
      token: rawToken,
    }, db);
    await linkToken.consume(rawToken, db);

    assert.equal(created.token, rawToken);
    assert.equal(db.calls[0].params[1], linkToken.hashToken(rawToken));
    assert.ok(!db.calls[0].params.includes(rawToken));
    assert.match(db.calls[1].sql, /consumed_at IS NULL AND expires_at > NOW\(\)/);
  });

  it('keeps Telegram bigint identities as strings and disconnects durably', async () => {
    const db = fakeDb();
    await connection.create({
      userId: 7,
      telegramUserId: 9007199254740991n,
      chatId: 9007199254740990n,
      username: ' user ',
    }, db);
    await connection.disconnect(12, db);
    await connection.setDeliveryStatus({
      userId: 7,
      status: 'paused',
      expectedVersion: 4,
    }, db);

    assert.equal(db.calls[0].params[1], '9007199254740991');
    assert.equal(db.calls[0].params[2], '9007199254740990');
    assert.match(db.calls[1].sql, /status = 'disconnected'/);
    assert.match(db.calls[1].sql, /access_suspended_at = NULL/);
    assert.match(db.calls[1].sql, /version = version \+ 1/);
    assert.match(db.calls[1].sql, /\$2::integer IS NULL OR version = \$2/);
    assert.deepEqual(db.calls[1].params, [12, null]);
    assert.match(db.calls[2].sql, /status IN \('active', 'paused'\)/);
    assert.match(db.calls[2].sql, /version = \$3/);
    assert.deepEqual(db.calls[2].params, [7, 'paused', 4]);
    await assert.rejects(
      () => connection.setDeliveryStatus({
        userId: 7, status: 'access_suspended', expectedVersion: 4,
      }, db),
      /Unsupported Telegram delivery status/
    );
  });

  it('deduplicates update intake and restricts terminal states', async () => {
    const db = fakeDb();
    await update.receive(123n, db);
    await update.markProcessed(123n, db);
    await update.markFailed(124n, 'redacted failure', db);

    assert.match(db.calls[0].sql, /ON CONFLICT \(update_id\) DO UPDATE/);
    assert.match(db.calls[0].sql, /WHERE telegram_updates.status = 'failed'/);
    assert.match(db.calls[0].sql, /received_at < NOW\(\) - INTERVAL '5 minutes'/);
    assert.deepEqual(db.calls[0].params, ['123']);
    assert.match(db.calls[1].sql, /WHERE update_id = \$1 AND status = 'received'/);
    assert.deepEqual(db.calls[2].params, ['124', 'failed', 'redacted failure']);
  });
});
