process.env.NODE_ENV = 'test';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const userAlertPresence = require('../src/models/user-alert-presence');
const stage49 = require('../src/utils/db-init-stage49');
const { assertUsingTestDatabase } = require('./helpers/test-db');

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

async function createTestUser(suffix, label) {
  const { rows } = await db.query(
    `INSERT INTO users (
       username,
       email,
       password_hash,
       is_email_verified,
       access_status,
       access_source
     )
     VALUES ($1, $2, $3, TRUE, 'active', 'manual')
     RETURNING id`,
    [
      `presence_${label}_${suffix}`,
      `presence_${label}_${suffix}@test.local`,
      'test-password-hash',
    ]
  );
  return Number(rows[0].id);
}

describe('user alert presence model integration', () => {
  const createdUserIds = [];
  let userA;
  let userB;

  before(async () => {
    await assertUsingTestDatabase(db);
    await stage49.init({ closePool: false });

    const suffix = `${Date.now()}_${process.pid}`;
    userA = await createTestUser(suffix, 'a');
    userB = await createTestUser(suffix, 'b');
    createdUserIds.push(userA, userB);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_alert_presences WHERE user_id = ANY($1::int[])', [createdUserIds]);
  });

  after(async () => {
    await db.query('DELETE FROM user_alert_presences WHERE user_id = ANY($1::int[])', [createdUserIds]).catch(() => {});
    await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]).catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('upserts foreground presence and expires it after the current foreground TTL', async () => {
    const base = new Date('2026-07-08T12:00:00.000Z');

    const presence = await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-a',
      socketId: 'socket-a',
      webInstanceId: 'web-a',
      mode: 'foreground',
    }, { now: base });

    assert.equal(presence.mode, 'foreground');
    assert.equal(presence.foregroundSeenAt, base.toISOString());
    assert.equal(presence.activeUntilAt, addMs(base, userAlertPresence.FOREGROUND_TTL_MS).toISOString());

    const activeBeforeExpiry = await userAlertPresence.listActive(
      { userId: userA },
      { now: addMs(base, userAlertPresence.FOREGROUND_TTL_MS - 1) }
    );
    assert.deepEqual(activeBeforeExpiry.map((row) => row.socketId), ['socket-a']);

    const activeAfterExpiry = await userAlertPresence.listActive(
      { userId: userA },
      { now: addMs(base, userAlertPresence.FOREGROUND_TTL_MS + 1) }
    );
    assert.deepEqual(activeAfterExpiry, []);
  });

  it('keeps the original hidden start while sliding the hidden grace limit', async () => {
    const base = new Date('2026-07-08T13:00:00.000Z');

    const firstHidden = await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-a',
      socketId: 'socket-a',
      webInstanceId: 'web-a',
      mode: 'hidden',
      hiddenGraceMs: userAlertPresence.HIDDEN_GRACE_MAX_MS,
    }, { now: base });

    const heartbeatAt = addMs(base, 15_000);
    const secondHidden = await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-a',
      socketId: 'socket-a',
      webInstanceId: 'web-a',
      mode: 'hidden',
      hiddenGraceMs: userAlertPresence.HIDDEN_GRACE_MAX_MS,
    }, { now: heartbeatAt });

    assert.equal(secondHidden.hiddenStartedAt, firstHidden.hiddenStartedAt);
    assert.equal(
      secondHidden.hiddenGraceUntilAt,
      addMs(heartbeatAt, userAlertPresence.HIDDEN_GRACE_MAX_MS).toISOString()
    );

    const activeBeforeSlidingExpiry = await userAlertPresence.listActive(
      { userId: userA },
      { now: addMs(base, userAlertPresence.HIDDEN_GRACE_MAX_MS + 10_000) }
    );
    assert.deepEqual(activeBeforeSlidingExpiry.map((row) => row.socketId), ['socket-a']);

    const activeAfterSlidingExpiry = await userAlertPresence.listActive(
      { userId: userA },
      { now: addMs(base, userAlertPresence.HIDDEN_GRACE_MAX_MS + 16_000) }
    );
    assert.deepEqual(activeAfterSlidingExpiry, []);
  });

  it('marks disconnects inactive without affecting other sockets for the same user', async () => {
    const base = new Date('2026-07-08T14:00:00.000Z');

    await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-a',
      socketId: 'socket-a',
      webInstanceId: 'web-a',
      mode: 'hidden',
      hiddenGraceMs: userAlertPresence.HIDDEN_GRACE_MAX_MS,
    }, { now: base });
    await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-b',
      socketId: 'socket-b',
      webInstanceId: 'web-a',
      mode: 'foreground',
    }, { now: base });
    await userAlertPresence.upsert({
      userId: userB,
      sessionKey: 'session-c',
      socketId: 'socket-c',
      webInstanceId: 'web-a',
      mode: 'foreground',
    }, { now: base });

    const activeSockets = await userAlertPresence.listActive({ userId: userA }, { now: addMs(base, 1_000) });
    assert.deepEqual(activeSockets.map((row) => row.socketId).sort(), ['socket-a', 'socket-b']);

    const disconnected = await userAlertPresence.disconnect({
      webInstanceId: 'web-a',
      socketId: 'socket-a',
    }, { now: addMs(base, 2_000) });

    assert.equal(disconnected.mode, 'inactive');
    assert.equal(disconnected.disconnectedAt, addMs(base, 2_000).toISOString());

    const remainingSockets = await userAlertPresence.listActive({ userId: userA }, { now: addMs(base, 3_000) });
    assert.deepEqual(remainingSockets.map((row) => row.socketId), ['socket-b']);
  });

  it('does not leave users active indefinitely when web restarts before disconnect', async () => {
    const base = new Date('2026-07-08T15:00:00.000Z');

    await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-a',
      socketId: 'socket-a',
      webInstanceId: 'web-before-restart',
      mode: 'hidden',
      hiddenGraceMs: userAlertPresence.HIDDEN_GRACE_MAX_MS,
    }, { now: base });

    const activeBeforeExpiry = await userAlertPresence.listActive(
      { userId: userA },
      { now: addMs(base, userAlertPresence.HIDDEN_GRACE_MAX_MS - 1) }
    );
    assert.deepEqual(activeBeforeExpiry.map((row) => row.socketId), ['socket-a']);

    const activeAfterExpiry = await userAlertPresence.listActive(
      { userId: userA },
      { now: addMs(base, userAlertPresence.HIDDEN_GRACE_MAX_MS + 1) }
    );
    assert.deepEqual(activeAfterExpiry, []);
  });

  it('cleans up expired and disconnected presence rows', async () => {
    const base = new Date('2026-07-08T16:00:00.000Z');

    await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-a',
      socketId: 'socket-expired',
      webInstanceId: 'web-a',
      mode: 'foreground',
    }, { now: base });
    await userAlertPresence.upsert({
      userId: userA,
      sessionKey: 'session-b',
      socketId: 'socket-disconnected',
      webInstanceId: 'web-a',
      mode: 'foreground',
    }, { now: base });
    await userAlertPresence.disconnect({
      webInstanceId: 'web-a',
      socketId: 'socket-disconnected',
    }, { now: addMs(base, 1_000) });

    const deletedCount = await userAlertPresence.cleanupExpired({
      now: addMs(base, userAlertPresence.FOREGROUND_TTL_MS + 1),
    });

    assert.equal(deletedCount, 2);
    const remaining = await userAlertPresence.listActive({ userId: userA }, { now: addMs(base, 2_000) });
    assert.deepEqual(remaining, []);
  });
});
