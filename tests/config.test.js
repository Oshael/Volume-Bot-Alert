process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');
const { CONFIG_SCHEMA } = require('../src/models/user-config');

const VALID_ADDR_1 = 'So11111111111111111111111111111111111111112';
const VALID_ADDR_2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const VALID_ADDR_3 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const INVALID_ADDR = 'not-a-valid-address!!!';
const VALID_EVM_ADDR = `0x${'a'.repeat(40)}`;

function getQueryToken(actionUrl) {
  assert.ok(actionUrl, 'Expected actionUrl in email debug payload');
  const parsed = new URL(actionUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token, 'Expected token query param in actionUrl');
  return token;
}

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.emailVerificationRequired, true);

  const verificationToken = getQueryToken(registerResponse.body.emailDebug?.actionUrl);
  const verifyResponse = await request(app)
    .post('/api/auth/verify-email/confirm')
    .send({ token: verificationToken });

  assert.equal(verifyResponse.status, 200);
}

async function completeLogin(email, password) {
  const loginResponse = await request(app)
    .post('/api/auth/login')
    .send({ email, password });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.otpRequired, true);
  assert.ok(loginResponse.body.challengeToken);
  assert.ok(loginResponse.body.emailDebug?.otpCode);

  const verifyResponse = await request(app)
    .post('/api/auth/login-otp/verify')
    .send({
      challengeToken: loginResponse.body.challengeToken,
      code: loginResponse.body.emailDebug.otpCode,
    });

  assert.equal(verifyResponse.status, 200);
  assert.ok(verifyResponse.body.token);
  return verifyResponse.body.token;
}

async function ensureAccessSchema() {
  const statements = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status VARCHAR(16) NOT NULL DEFAULT 'inactive'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_source VARCHAR(16) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE users ALTER COLUMN access_status SET DEFAULT 'inactive'`,
    `ALTER TABLE users ALTER COLUMN access_granted_at SET DEFAULT NOW()`,
    `ALTER TABLE users ALTER COLUMN access_source SET DEFAULT 'manual'`,
    `ALTER TABLE users ALTER COLUMN access_updated_at SET DEFAULT NOW()`,
    `ALTER TABLE invites ADD COLUMN IF NOT EXISTS grant_access_days INTEGER`,
    `ALTER TABLE invites ADD COLUMN IF NOT EXISTS grant_access_source VARCHAR(16) NOT NULL DEFAULT 'invite'`,
    `ALTER TABLE invites ALTER COLUMN grant_access_source SET DEFAULT 'invite'`,
  ];

  for (const statement of statements) {
    await db.query(statement);
  }
}

async function createVerifiedUser({ username, email, password, role = 'user' }) {
  const invite = await Invite.create(null, { maxUses: 2, expiryHours: 24, grantAccessDays: 30 });
  const registerResponse = await request(app)
    .post('/api/auth/register')
    .send({ username, email, password, inviteCode: invite.code });

  await verifyEmailFromRegisterResponse(registerResponse);

  if (role === 'admin') {
    await db.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }

  return completeLogin(email, password);
}

describe('Config routes', () => {
  let userToken;
  let adminToken;

  before(async () => {
    await ensureAccessSchema();
    await db.query('DELETE FROM user_starred_tokens');
    await db.query('DELETE FROM user_blocklist');
    await db.query('DELETE FROM user_tokens');
    await db.query('DELETE FROM user_ui_prefs');
    await db.query('DELETE FROM user_configs');
    await db.query('DELETE FROM sessions');
    await db.query('DELETE FROM login_attempts');
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM invites');
    await db.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});

    const suffix = Date.now();
    userToken = await createVerifiedUser({
      username: `configuser_${suffix}`,
      email: `configuser_${suffix}@test.com`,
      password: 'TestPass123!',
    });
    adminToken = await createVerifiedUser({
      username: `configadmin_${suffix}`,
      email: `configadmin_${suffix}@test.com`,
      password: 'AdminPass123!',
      role: 'admin',
    });
  });

  after(async () => {
    if (server && server.close) {
      server.close();
    }
    await db.pool.end().catch(() => {});
  });

  it('rejects config routes without authentication', async () => {
    const responses = await Promise.all([
      request(app).get('/api/config'),
      request(app).put('/api/config').send({ configs: {} }),
      request(app).patch('/api/config').send({ configs: {} }),
      request(app).post('/api/config/tokens').send({ address: VALID_ADDR_1 }),
      request(app).post('/api/config/blocklist').send({ address: VALID_ADDR_1 }),
    ]);

    for (const response of responses) {
      assert.equal(response.status, 401);
    }
  });

  it('returns default config payload for a fresh user', async () => {
    const response = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.tokens, []);
    assert.deepEqual(response.body.blocklist, []);
    assert.deepEqual(response.body.starredTokens, []);
    assert.ok(response.body.uiPrefs);

    for (const key of Object.keys(CONFIG_SCHEMA)) {
      assert.ok(Object.hasOwn(response.body.configs, key), `missing config key ${key}`);
    }

    assert.equal(response.body.configs.threshold, 50);
    assert.equal(response.body.configs.interval, 30);
    assert.equal(response.body.configs.chain, 'solana');
    assert.equal(response.body.configs['block-warning-enabled'], 'on');
    assert.equal(response.body.configs['min-vol'], 8000);
    assert.equal(response.body.configs['card-effects-mode'], 'on');
    assert.equal(response.body.configs['old-mcap-min'], 120000);
    assert.equal(response.body.configs['old-mcap-max'], 100000000);
    assert.equal(response.body.configs['old-week-mcap-min'], 120000);
    assert.equal(response.body.configs['old-week-mcap-max'], 100000000);
    assert.equal(response.body.configs['old-per-page'], 30);
    assert.equal(response.body.configs['old-week-per-page'], 30);

    assert.deepEqual(response.body.uiPrefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre']);
    assert.deepEqual(response.body.uiPrefs.monitoredSorts, [{ mode: 'vol', window: '5m' }]);
    assert.deepEqual(response.body.uiPrefs.recentSorts, [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]);
    assert.deepEqual(response.body.uiPrefs.oldWeekSorts, [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]);
    assert.deepEqual(response.body.uiPrefs.livePanelLayout, {
      order: ['monitored', 'pumpfun', 'alerts'],
      spans: {
        monitored: 1,
        pumpfun: 1,
        alerts: 1,
      },
    });
    assert.equal(response.body.uiPrefs.recentPerPage, 30);
    assert.equal(response.body.uiPrefs.oldWeekPerPage, 30);
  });

  it('patches config values and persists them on subsequent reads', async () => {
    const patchResponse = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        configs: {
          threshold: 80,
          interval: 15,
          'block-warning-enabled': 'off',
          'card-effects-mode': 'off',
        },
      });

    assert.equal(patchResponse.status, 200);
    assert.deepEqual(patchResponse.body.configs, {
      threshold: 80,
      interval: 15,
      'block-warning-enabled': 'off',
      'card-effects-mode': 'off',
    });

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs.threshold, 80);
    assert.equal(getResponse.body.configs.interval, 15);
    assert.equal(getResponse.body.configs['block-warning-enabled'], 'off');
    assert.equal(getResponse.body.configs['card-effects-mode'], 'off');
  });

  it('rejects invalid and empty config patches', async () => {
    const responses = await Promise.all([
      request(app)
        .patch('/api/config')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ configs: { 'hacker-key': 'oops' } }),
      request(app)
        .patch('/api/config')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ configs: { threshold: 'abc' } }),
      request(app)
        .patch('/api/config')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ configs: {} }),
    ]);

    assert.equal(responses[0].status, 400);
    assert.match(responses[0].body.error, /Invalid config values/i);
    assert.match(responses[0].body.details[0], /Unknown config key/i);

    assert.equal(responses[1].status, 400);
    assert.match(responses[1].body.details[0], /must be a finite number/i);

    assert.equal(responses[2].status, 400);
    assert.match(responses[2].body.error, /configs object is required/i);
  });

  it('strips restricted chain updates for non-admin users', async () => {
    const patchResponse = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ configs: { chain: 'ethereum' } });

    assert.equal(patchResponse.status, 400);
    assert.match(patchResponse.body.error, /configs object is required/i);

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs.chain, 'solana');
  });

  it('allows admins to update restricted chain config', async () => {
    const patchResponse = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ configs: { chain: 'ethereum' } });

    assert.equal(patchResponse.status, 200);
    assert.deepEqual(patchResponse.body.configs, { chain: 'ethereum' });

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs.chain, 'ethereum');
  });

  it('fully syncs configs, manual tokens, blocklist, starred tokens and resets omitted config keys to defaults', async () => {
    const response = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        configs: {
          threshold: 75,
          interval: 45,
        },
        tokens: [
          { address: VALID_ADDR_1, label: 'SOL' },
          { address: VALID_EVM_ADDR, label: 'EVM' },
        ],
        blocklist: [
          { address: VALID_ADDR_3, label: 'SCAM' },
        ],
        starredTokens: [
          { address: VALID_ADDR_1 },
          { address: VALID_ADDR_3 },
        ],
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.configs.threshold, 75);
    assert.equal(response.body.configs.interval, 45);
    assert.equal(response.body.configs['block-warning-enabled'], 'on');
    assert.equal(response.body.tokens.length, 2);
    assert.equal(response.body.blocklist.length, 1);
    assert.deepEqual(response.body.starredTokens.map((item) => item.address), [VALID_ADDR_1, VALID_ADDR_3]);
  });

  it('rejects invalid full sync requests without persisting partial changes', async () => {
    const beforeResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    const response = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        configs: { threshold: 123 },
        tokens: [{ address: INVALID_ADDR }],
      });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /invalid token address/i);

    const afterResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(afterResponse.status, 200);
    assert.equal(afterResponse.body.configs.threshold, beforeResponse.body.configs.threshold);
    assert.deepEqual(afterResponse.body.tokens, beforeResponse.body.tokens);
  });

  it('supports manual token CRUD with address normalization', async () => {
    const createResponse = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: `  ${VALID_ADDR_2}  `, label: 'Wrapped USDC' });

    assert.equal(createResponse.status, 201);
    assert.equal(createResponse.body.token.address, VALID_ADDR_2);
    assert.equal(createResponse.body.token.label, 'Wrapped USDC');

    const duplicateResponse = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: VALID_ADDR_2 });

    assert.equal(duplicateResponse.status, 409);

    const deleteResponse = await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_2}`)
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(deleteResponse.status, 200);
    assert.match(deleteResponse.body.message, /removed/i);
  });

  it('supports blocklist CRUD', async () => {
    const createResponse = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: VALID_ADDR_2, label: 'Suspicious' });

    assert.equal(createResponse.status, 201);
    assert.equal(createResponse.body.blocked.address, VALID_ADDR_2);

    const duplicateResponse = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: VALID_ADDR_2 });

    assert.equal(duplicateResponse.status, 409);

    const deleteResponse = await request(app)
      .delete(`/api/config/blocklist/${VALID_ADDR_2}`)
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(deleteResponse.status, 200);
    assert.match(deleteResponse.body.message, /unblocked/i);
  });

  it('patches ui prefs independently from config values', async () => {
    const response = await request(app)
      .patch('/api/config/ui-prefs')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        uiPrefs: {
          manualStarredOnly: true,
          enabledTradeTerminals: ['photon', 'bullx'],
          monitoredPerPage: 50,
          livePanelLayout: {
            order: ['alerts', 'monitored', 'pumpfun'],
            spans: {
              monitored: 2,
              pumpfun: 1,
              alerts: 3,
            },
          },
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.uiPrefs.manualStarredOnly, true);
    assert.equal(response.body.uiPrefs.monitoredPerPage, 50);
    assert.deepEqual(response.body.uiPrefs.enabledTradeTerminals, ['photon', 'bullx']);
    assert.deepEqual(response.body.uiPrefs.livePanelLayout, {
      order: ['alerts', 'monitored', 'pumpfun'],
      spans: {
        monitored: 2,
        pumpfun: 1,
        alerts: 3,
      },
    });
  });

  it('keeps config data isolated per user', async () => {
    const userResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);
    const adminResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(userResponse.status, 200);
    assert.equal(adminResponse.status, 200);
    assert.notEqual(userResponse.body.configs.threshold, adminResponse.body.configs.threshold);
    assert.notDeepEqual(userResponse.body.uiPrefs, adminResponse.body.uiPrefs);
    assert.notDeepEqual(userResponse.body.tokens, adminResponse.body.tokens);
    assert.notDeepEqual(userResponse.body.blocklist, adminResponse.body.blocklist);
    assert.notDeepEqual(userResponse.body.starredTokens, adminResponse.body.starredTokens);
  });
});
