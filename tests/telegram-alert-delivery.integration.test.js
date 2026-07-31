process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const deliveryModel = require('../src/models/telegram-alert-delivery');
const profileModel = require('../src/models/telegram-alert-profile');
const ruleSettingModel = require('../src/models/telegram-alert-rule-setting');
const connectionModel = require('../src/models/telegram-connection');
const stage84 = require('../src/utils/db-init-stage84');
const stage85 = require('../src/utils/db-init-stage85');
const stage89 = require('../src/utils/db-init-stage89');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = '11111111111111111111111111111111';
const suffix = `${Date.now()}_${process.pid}`;
let userId;
let profile;

async function createTestUser() {
  const { rows } = await db.query(
    `INSERT INTO users (
       username, email, password_hash, is_email_verified,
       is_active, access_status, access_source
     ) VALUES ($1, $2, $3, TRUE, TRUE, 'active', 'manual')
     RETURNING id`,
    [
      `tg_claim_${suffix}`.slice(0, 32),
      `telegram_claim_${suffix}@test.local`,
      'test-password-hash',
    ]
  );
  return Number(rows[0].id);
}

async function seedDeliveries() {
  await db.query(
    'DELETE FROM telegram_alert_deliveries WHERE profile_id = $1',
    [profile.id]
  );
  for (let index = 0; index < 4; index += 1) {
    await deliveryModel.createPending({
      connectionId: profile.connection_id,
      profileId: profile.id,
      chain: 'solana',
      ruleKey: 'monitored-vol',
      kind: 'monitored-vol',
      tokenAddress: TOKEN,
      dedupeKey: `integration:${suffix}:${index}`,
      payload: { symbol: `TEST${index}` },
      triggeredAt: new Date(Date.UTC(2026, 6, 29, 15, index)).toISOString(),
    });
  }
}

describe('Telegram alert delivery claim integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage84.init({ closePool: false });
    await stage85.init({ closePool: false });
    await stage89.init({ closePool: false });
    userId = await createTestUser();
    const numericSeed = BigInt(Date.now()) * 10_000n + BigInt(process.pid);
    const connection = await connectionModel.create({
      userId,
      telegramUserId: numericSeed,
      chatId: numericSeed + 1n,
      username: 'claim_test',
      firstName: 'Claim Test',
    });
    const profiles = await profileModel.bindConnection({
      userId,
      connectionId: connection.id,
    });
    await ruleSettingModel.ensureDefaults(profiles);
    profile = profiles.find((item) => item.chain === 'solana');
  });

  beforeEach(seedDeliveries);

  after(async () => {
    if (userId) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  });

  it('claims disjoint batches and rejects a stale owner after lease recovery', async () => {
    const [first, second] = await Promise.all([
      deliveryModel.claimReadyBatch({
        owner: 'integration-worker-a',
        limit: 2,
        leaseMs: 60_000,
      }),
      deliveryModel.claimReadyBatch({
        owner: 'integration-worker-b',
        limit: 2,
        leaseMs: 60_000,
      }),
    ]);
    const claimed = [...first, ...second];

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(new Set(claimed.map(({ id }) => id)).size, 4);
    assert.ok(claimed.every(({ attempts }) => attempts === 1));

    const expired = claimed[0];
    await db.query(
      `UPDATE telegram_alert_deliveries
       SET lease_until = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [expired.id]
    );
    const [reclaimed] = await deliveryModel.claimReadyBatch({
      owner: 'integration-worker-c',
      limit: 1,
      leaseMs: 60_000,
    });
    const staleRenewal = await deliveryModel.renewClaims({
      ids: [expired.id],
      owner: expired.leaseOwner,
      leaseMs: 60_000,
    });
    const currentRenewal = await deliveryModel.renewClaims({
      ids: [expired.id],
      owner: 'integration-worker-c',
      leaseMs: 60_000,
    });

    assert.equal(reclaimed.id, expired.id);
    assert.equal(reclaimed.attempts, 2);
    assert.deepEqual(staleRenewal, []);
    assert.deepEqual(currentRenewal.map(({ id }) => id), [expired.id]);
  });

  it('persists retry and terminal outcomes only for the current lease owner', async () => {
    const claimed = await deliveryModel.claimReadyBatch({
      owner: 'settlement-worker-a',
      limit: 4,
      leaseMs: 60_000,
    });
    const retryClaim = claimed[0];
    const retry = await deliveryModel.scheduleRetry({
      id: retryClaim.id,
      owner: 'settlement-worker-a',
      nextAttemptAt: new Date(Date.now() + 60_000),
      errorCode: 'api_unavailable',
      error: 'Temporary Telegram outage',
    });
    await db.query(
      `UPDATE telegram_alert_deliveries
       SET next_attempt_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [retryClaim.id]
    );
    const [reclaimed] = await deliveryModel.claimReadyBatch({
      owner: 'settlement-worker-b',
      limit: 1,
      leaseMs: 60_000,
    });
    const staleResult = await deliveryModel.markFailed({
      id: retryClaim.id,
      owner: 'settlement-worker-a',
      errorCode: 'stale',
      error: 'Stale worker result',
    });
    const sent = await deliveryModel.markSent({
      id: reclaimed.id,
      owner: 'settlement-worker-b',
      messageId: '9007199254740993',
      fileId: 'telegram-file-id',
    });
    const failed = await deliveryModel.markFailed({
      id: claimed[1].id,
      owner: 'settlement-worker-a',
      errorCode: 'bot_blocked',
      error: 'Bot blocked by user',
    });
    const cancelled = await deliveryModel.cancelClaim({
      id: claimed[2].id,
      owner: 'settlement-worker-a',
      errorCode: 'access_revoked',
      error: 'Product access revoked',
    });

    assert.equal(retry.status, 'retry');
    assert.equal(retry.leaseOwner, null);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(staleResult, null);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.telegramMessageId, '9007199254740993');
    assert.ok(sent.deliveredAt);
    assert.equal(failed.status, 'failed');
    assert.equal(cancelled.status, 'cancelled');
  });
});
