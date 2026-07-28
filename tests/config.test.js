process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';
process.env.ROBINHOOD_USER_VISIBILITY_ENABLED = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');
const adminBlockEvidence = require('../src/models/admin-block-evidence');
const adminBlockedToken = require('../src/models/admin-blocked-token');
const tokenCatalog = require('../src/models/token-catalog');
const stage4 = require('../src/utils/db-init-stage4');
const stage45 = require('../src/utils/db-init-stage45');
const stage53 = require('../src/utils/db-init-stage53');
const stage54 = require('../src/utils/db-init-stage54');
const stage55 = require('../src/utils/db-init-stage55');
const { CONFIG_SCHEMA } = require('../src/models/user-config');
const userAlertProfileCache = require('../src/services/user-alert-profile-cache');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VALID_ADDR_1 = 'So11111111111111111111111111111111111111112';
const VALID_ADDR_2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const VALID_ADDR_3 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const INVALID_ADDR = 'not-a-valid-address!!!';
const FOLDER_ONLY_ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6QXgB263vZyVfSRm';
const ROBINHOOD_ADDR_MIXED = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const ROBINHOOD_ADDR = ROBINHOOD_ADDR_MIXED.toLowerCase();

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
    await assertUsingTestDatabase(db);
    await ensureAccessSchema();
    await stage4.init({ closePool: false });
    await stage45.init({ closePool: false });
    await stage53.init({ closePool: false });
    await stage54.init({ closePool: false });
    await adminBlockedToken.ensureTable();
    await adminBlockEvidence.ensureTable();
    await stage55.init({ closePool: false });
    await db.query('DELETE FROM user_token_folder_items');
    await db.query('DELETE FROM user_token_folders');
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
    assert.deepEqual(response.body.availableChains, ['solana', 'robinhood']);
    assert.equal(response.body.chainReadiness.solana.status, 'ready');
    assert.ok(response.body.uiPrefs);

    const readinessResponse = await request(app)
      .get('/api/config/chain-readiness')
      .set('Authorization', `Bearer ${userToken}`);
    assert.equal(readinessResponse.status, 200);
    assert.deepEqual(readinessResponse.body.availableChains, ['solana', 'robinhood']);
    assert.equal(readinessResponse.body.chainReadiness.solana.workspaceReady, true);

    for (const key of Object.keys(CONFIG_SCHEMA)) {
      assert.ok(Object.hasOwn(response.body.configs, key), `missing config key ${key}`);
    }

    assert.equal(response.body.configs.threshold, 50);
    assert.equal(response.body.configs.interval, 30);
    assert.equal(response.body.configs.chain, 'solana');
    assert.equal(response.body.configs['block-warning-enabled'], 'on');
    assert.equal(response.body.configs['min-vol'], 10000);
    assert.equal(response.body.configs['card-effects-mode'], 'on');
    assert.equal(response.body.configs['old-mcap-min'], 120000);
    assert.equal(response.body.configs['old-mcap-max'], 100000000);
    assert.equal(response.body.configs['old-fdv-min'], 120000);
    assert.equal(response.body.configs['old-fdv-max'], 100000000);
    assert.equal(response.body.configs['recent-age-min'], 0);
    assert.equal(response.body.configs['recent-age-max'], 10080);
    assert.equal(response.body.configs['recent-surge-1h-threshold'], 50);
    assert.equal(response.body.configs['recent-surge-6h-threshold'], 100);
    assert.equal(response.body.configs['old-week-surge-1h-threshold'], 50);
    assert.equal(response.body.configs['old-week-surge-6h-threshold'], 100);
    assert.equal(response.body.configs['alert-recent-surge-1h-enabled'], 'on');
    assert.equal(response.body.configs['alert-recent-surge-6h-enabled'], 'on');
    assert.equal(response.body.configs['alert-old-week-surge-1h-enabled'], 'on');
    assert.equal(response.body.configs['alert-old-week-surge-6h-enabled'], 'on');
    assert.equal(response.body.configs['old-week-mcap-min'], 120000);
    assert.equal(response.body.configs['old-week-mcap-max'], 100000000);
    assert.equal(response.body.configs['old-week-fdv-min'], 120000);
    assert.equal(response.body.configs['old-week-fdv-max'], 100000000);
    assert.equal(response.body.configs['monitored-mcap-min'], 30000);
    assert.equal(response.body.configs['monitored-fdv-min'], 30000);
    assert.equal(response.body.configs['monitored-view-mcap-max'], 0);
    assert.equal(response.body.configs['monitored-view-fdv-max'], 0);
    assert.equal(response.body.configs['old-week-age-min'], 10080);
    assert.equal(response.body.configs['old-week-age-max'], 0);
    assert.equal(response.body.configs['old-per-page'], 15);
    assert.equal(response.body.configs['old-week-per-page'], 15);
    assert.equal(response.body.configs['mock-sol-usdc-rate'], 88);

    assert.deepEqual(response.body.uiPrefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo']);
    assert.deepEqual(response.body.uiPrefs.monitoredSorts, [{ mode: 'vol', window: '5m' }]);
    assert.deepEqual(response.body.uiPrefs.recentSorts, [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]);
    assert.deepEqual(response.body.uiPrefs.oldWeekSorts, [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]);
    assert.equal(response.body.uiPrefs.expandedSparklineGranularityMinutes, 5);
    assert.deepEqual(response.body.uiPrefs.sparklineRange, {
      monitoredDays: 14,
      recentDays: 14,
      oldWeekDays: 14,
      monitoredPreset: '14d',
      recentPreset: '14d',
      oldWeekPreset: '14d',
      tokenDaysByAddress: {},
      tokenPresetByAddress: {},
    });
    assert.deepEqual(response.body.uiPrefs.livePanelLayout, {
      order: ['monitored', 'pumpfun', 'alerts'],
      spans: {
        monitored: 2,
        pumpfun: 1,
        alerts: 1,
      },
      heights: {
        monitored: 620,
        alerts: 620,
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
          'recent-surge-1h-threshold': 22,
          'alert-old-week-surge-6h-enabled': 'off',
          'block-warning-enabled': 'off',
          'card-effects-mode': 'off',
          'recent-age-min': 30,
          'recent-age-max': 120,
          'old-week-age-min': 20160,
          'old-week-age-max': 43200,
          'monitored-mcap-min': 45000,
          'monitored-fdv-min': 65000,
          'monitored-view-mcap-max': 950000,
          'monitored-view-fdv-max': 1250000,
          'old-fdv-min': 140000,
          'old-fdv-max': 90000000,
          'old-week-fdv-min': 160000,
          'old-week-fdv-max': 80000000,
          'solana-threshold': 67,
          'robinhood-threshold': 91,
          'robinhood-alert-fdv-enabled': 'on',
        },
      });

    assert.equal(patchResponse.status, 200);
    assert.deepEqual(patchResponse.body.configs, {
      threshold: 80,
      interval: 15,
      'recent-surge-1h-threshold': 22,
      'alert-old-week-surge-6h-enabled': 'off',
      'block-warning-enabled': 'off',
      'card-effects-mode': 'off',
      'recent-age-min': 30,
      'recent-age-max': 120,
      'old-week-age-min': 20160,
      'old-week-age-max': 43200,
      'monitored-mcap-min': 45000,
      'monitored-fdv-min': 65000,
      'monitored-view-mcap-max': 950000,
      'monitored-view-fdv-max': 1250000,
      'old-fdv-min': 140000,
      'old-fdv-max': 90000000,
      'old-week-fdv-min': 160000,
      'old-week-fdv-max': 80000000,
      'solana-threshold': 67,
      'robinhood-threshold': 91,
      'robinhood-alert-fdv-enabled': 'on',
    });

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs.threshold, 80);
    assert.equal(getResponse.body.configs.interval, 15);
    assert.equal(getResponse.body.configs['recent-surge-1h-threshold'], 22);
    assert.equal(getResponse.body.configs['alert-old-week-surge-6h-enabled'], 'off');
    assert.equal(getResponse.body.configs['block-warning-enabled'], 'off');
    assert.equal(getResponse.body.configs['card-effects-mode'], 'off');
    assert.equal(getResponse.body.configs['recent-age-min'], 30);
    assert.equal(getResponse.body.configs['recent-age-max'], 120);
    assert.equal(getResponse.body.configs['old-week-age-min'], 20160);
    assert.equal(getResponse.body.configs['old-week-age-max'], 43200);
    assert.equal(getResponse.body.configs['monitored-mcap-min'], 45000);
    assert.equal(getResponse.body.configs['monitored-fdv-min'], 65000);
    assert.equal(getResponse.body.configs['monitored-view-mcap-max'], 950000);
    assert.equal(getResponse.body.configs['monitored-view-fdv-max'], 1250000);
    assert.equal(getResponse.body.configs['old-fdv-min'], 140000);
    assert.equal(getResponse.body.configs['old-fdv-max'], 90000000);
    assert.equal(getResponse.body.configs['old-week-fdv-min'], 160000);
    assert.equal(getResponse.body.configs['old-week-fdv-max'], 80000000);
    assert.equal(getResponse.body.configs['solana-threshold'], 67);
    assert.equal(getResponse.body.configs['robinhood-threshold'], 91);
    assert.equal(getResponse.body.configs['robinhood-alert-fdv-enabled'], 'on');
  });

  it('mirrors legacy surge config values into the new recent and old-week keys on read when the new keys were never stored', async () => {
    const patchResponse = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        configs: {
          'old-alert-1h-threshold': 31,
          'old-alert-6h-threshold': 125,
          'alert-old-surge-1h-enabled': 'off',
          'alert-old-surge-6h-enabled': 'off',
        },
        tokens: [],
        blocklist: [],
        starredTokens: [],
      });

    assert.equal(patchResponse.status, 200);

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs['recent-surge-1h-threshold'], 31);
    assert.equal(getResponse.body.configs['recent-surge-6h-threshold'], 125);
    assert.equal(getResponse.body.configs['old-week-surge-1h-threshold'], 31);
    assert.equal(getResponse.body.configs['old-week-surge-6h-threshold'], 125);
    assert.equal(getResponse.body.configs['alert-recent-surge-1h-enabled'], 'off');
    assert.equal(getResponse.body.configs['alert-recent-surge-6h-enabled'], 'off');
    assert.equal(getResponse.body.configs['alert-old-week-surge-1h-enabled'], 'off');
    assert.equal(getResponse.body.configs['alert-old-week-surge-6h-enabled'], 'off');
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

  it('strips restricted mock SOL rate updates for non-admin users', async () => {
    const patchResponse = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ configs: { 'mock-sol-usdc-rate': 120 } });

    assert.equal(patchResponse.status, 400);
    assert.match(patchResponse.body.error, /configs object is required/i);

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs['mock-sol-usdc-rate'], 88);
  });

  it('allows admins to update restricted chain config', async () => {
    const patchResponse = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ configs: { chain: 'ethereum', 'mock-sol-usdc-rate': 123.45 } });

    assert.equal(patchResponse.status, 200);
    assert.deepEqual(patchResponse.body.configs, { chain: 'ethereum', 'mock-sol-usdc-rate': 123.45 });

    const getResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.configs.chain, 'ethereum');
    assert.equal(getResponse.body.configs['mock-sol-usdc-rate'], 123.45);
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
    assert.equal(response.body.tokens.length, 1);
    assert.equal(response.body.blocklist.length, 1);
    assert.deepEqual(
      response.body.starredTokens.map((item) => item.address).sort(),
      [VALID_ADDR_1, VALID_ADDR_3].sort(),
    );
    assert.deepEqual(response.body.availableChains, ['solana', 'robinhood']);
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

  it('reactivates soft-archived catalog rows when adding a manual token', async () => {
    const originalGetByAddress = tokenCatalog.getByAddress;
    const originalReactivateSoftArchivedToken = tokenCatalog.reactivateSoftArchivedToken;
    const originalUpsertToken = tokenCatalog.upsertToken;
    const originalScheduleImmediateEvaluation = tokenCatalog.scheduleImmediateEvaluation;
    let reactivatedAddress = null;
    let upsertCalls = 0;
    let scheduleCalls = 0;

    tokenCatalog.getByAddress = async (address) => ({
      address,
      suppressed_reason: 'cleanup_soft_archive',
    });
    tokenCatalog.reactivateSoftArchivedToken = async (address) => {
      reactivatedAddress = address;
      return { address };
    };
    tokenCatalog.upsertToken = async () => {
      upsertCalls += 1;
      return { address: VALID_ADDR_2 };
    };
    tokenCatalog.scheduleImmediateEvaluation = async () => {
      scheduleCalls += 1;
      return null;
    };

    try {
      const createResponse = await request(app)
        .post('/api/config/tokens')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ address: VALID_ADDR_2 });

      assert.equal(createResponse.status, 201);
      assert.equal(reactivatedAddress, VALID_ADDR_2);
      assert.equal(upsertCalls, 0);
      assert.equal(scheduleCalls, 0);
    } finally {
      tokenCatalog.getByAddress = originalGetByAddress;
      tokenCatalog.reactivateSoftArchivedToken = originalReactivateSoftArchivedToken;
      tokenCatalog.upsertToken = originalUpsertToken;
      tokenCatalog.scheduleImmediateEvaluation = originalScheduleImmediateEvaluation;
    }
  });

  it('supports manual token folder CRUD and destructive folder delete', async () => {
    const createRoot = await request(app)
      .post('/api/config/token-folders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Utility coins' });

    assert.equal(createRoot.status, 201);
    assert.equal(createRoot.body.folder.name, 'Utility coins');

    const addItem = await request(app)
      .post(`/api/config/token-folders/${createRoot.body.folder.id}/tokens`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: FOLDER_ONLY_ADDR });

    assert.equal(addItem.status, 201);
    assert.equal(addItem.body.item.address, FOLDER_ONLY_ADDR);
    assert.equal(addItem.body.tokenCreated, true);

    const listResponse = await request(app)
      .get('/api/config/token-folders')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.folders.length, 1);
    assert.deepEqual(listResponse.body.items.map((item) => item.address), [FOLDER_ONLY_ADDR]);

    const configWithFolderToken = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(configWithFolderToken.status, 200);
    assert.equal(configWithFolderToken.body.tokens.some((item) => item.address === FOLDER_ONLY_ADDR), true);

    const deleteResponse = await request(app)
      .delete(`/api/config/token-folders/${createRoot.body.folder.id}`)
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(deleteResponse.body.removedTokens, [FOLDER_ONLY_ADDR]);

    const configResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.body.tokens.some((item) => item.address === FOLDER_ONLY_ADDR), false);
  });

  it('persists Robinhood collections immediately and keeps destructive folder deletion chain-aware', async () => {
    const invalidResponse = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ chain: 'robinhood', address: INVALID_ADDR });
    assert.equal(invalidResponse.status, 400);

    const manualResponse = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ chain: 'robinhood', address: ROBINHOOD_ADDR_MIXED, label: 'RH manual' });
    assert.equal(manualResponse.status, 201);
    assert.deepEqual(
      { chain: manualResponse.body.token.chain, address: manualResponse.body.token.address },
      { chain: 'robinhood', address: ROBINHOOD_ADDR },
    );

    const [starResponse, blockResponse, folderResponse] = await Promise.all([
      request(app)
        .post('/api/config/starred')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ chain: 'robinhood', address: ROBINHOOD_ADDR_MIXED }),
      request(app)
        .post('/api/config/blocklist')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ chain: 'robinhood', address: ROBINHOOD_ADDR_MIXED, label: 'RH blocked' }),
      request(app)
        .post('/api/config/token-folders')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Robinhood destructive folder' }),
    ]);
    assert.equal(starResponse.status, 201);
    assert.equal(blockResponse.status, 201);
    assert.equal(folderResponse.status, 201);

    const addFolderItem = await request(app)
      .post(`/api/config/token-folders/${folderResponse.body.folder.id}/tokens`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ chain: 'robinhood', address: ROBINHOOD_ADDR_MIXED });
    assert.equal(addFolderItem.status, 201);
    assert.equal(addFolderItem.body.tokenCreated, false);
    assert.equal(addFolderItem.body.item.chain, 'robinhood');

    const legacySync = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ tokens: [], blocklist: [], starredTokens: [] });
    assert.equal(legacySync.status, 200);
    assert.equal(legacySync.body.tokens.some((item) => (
      item.chain === 'robinhood' && item.address === ROBINHOOD_ADDR
    )), true);
    assert.equal(legacySync.body.starredTokens.some((item) => item.chain === 'robinhood'), true);
    assert.equal(legacySync.body.blocklist.some((item) => item.chain === 'robinhood'), true);

    const deleteFolder = await request(app)
      .delete(`/api/config/token-folders/${folderResponse.body.folder.id}`)
      .set('Authorization', `Bearer ${userToken}`);
    assert.equal(deleteFolder.status, 200);
    assert.deepEqual(deleteFolder.body.removedTokens, [ROBINHOOD_ADDR]);
    assert.deepEqual(deleteFolder.body.removedTokenIdentities, [{
      chain: 'robinhood', address: ROBINHOOD_ADDR,
    }]);

    const afterDelete = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);
    assert.equal(afterDelete.body.tokens.some((item) => item.address === ROBINHOOD_ADDR), false);
    assert.equal(afterDelete.body.starredTokens.some((item) => item.address === ROBINHOOD_ADDR), true);
    assert.equal(afterDelete.body.blocklist.some((item) => item.address === ROBINHOOD_ADDR), true);

    const [removeStar, removeBlock] = await Promise.all([
      request(app)
        .delete(`/api/config/starred/${ROBINHOOD_ADDR}?chain=robinhood`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app)
        .delete(`/api/config/blocklist/${ROBINHOOD_ADDR}?chain=robinhood`)
        .set('Authorization', `Bearer ${userToken}`),
    ]);
    assert.equal(removeStar.status, 200);
    assert.equal(removeBlock.status, 200);

    const afterInverseReload = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);
    assert.equal(afterInverseReload.status, 200);
    assert.equal(afterInverseReload.body.starredTokens.some((item) => (
      item.chain === 'robinhood' && item.address === ROBINHOOD_ADDR
    )), false);
    assert.equal(afterInverseReload.body.blocklist.some((item) => (
      item.chain === 'robinhood' && item.address === ROBINHOOD_ADDR
    )), false);
  });

  it('rejects manual token subfolders', async () => {
    const createRoot = await request(app)
      .post('/api/config/token-folders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Root only' });

    assert.equal(createRoot.status, 201);

    const subfolder = await request(app)
      .post('/api/config/token-folders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Nested', parentFolderId: createRoot.body.folder.id });

    assert.equal(subfolder.status, 400);
    assert.match(subfolder.body.error, /subfolders are not supported/i);
  });

  it('removes a linked folder token from manual tokens through the folder item route', async () => {
    await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: VALID_ADDR_2, label: 'Wrapped USDC' });

    const createFolder = await request(app)
      .post('/api/config/token-folders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Delete linked token' });

    assert.equal(createFolder.status, 201);

    const addItem = await request(app)
      .post(`/api/config/token-folders/${createFolder.body.folder.id}/tokens`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: VALID_ADDR_2 });

    assert.equal(addItem.status, 201);

    const deleteItem = await request(app)
      .delete(`/api/config/token-folders/${createFolder.body.folder.id}/tokens/${VALID_ADDR_2}`)
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(deleteItem.status, 200);

    const configResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(configResponse.body.tokens.some((item) => item.address === VALID_ADDR_2), false);
  });

  it('supports blocklist CRUD', async () => {
    const createResponse = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ address: VALID_ADDR_2, label: 'Suspicious' });

    assert.equal(createResponse.status, 201);
    assert.equal(createResponse.body.blocked.address, VALID_ADDR_2);

    const imageUrl = 'https://example.com/usdc.png';
    await db.query('UPDATE token_catalog SET last_image_url = $1 WHERE address = $2', [imageUrl, VALID_ADDR_2]);
    const configResponse = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.body.blocklist.find((item) => item.address === VALID_ADDR_2)?.imageUrl, imageUrl);

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
          manualFolderDeleteWarningDismissed: true,
          chainFilters: {
            enabledChains: ['solana'],
            radarChains: ['solana'],
            alertFeedChains: ['solana'],
            browserNotificationChains: ['solana'],
          },
          enabledTradeTerminals: ['photon', 'bullx'],
          monitoredPerPage: 50,
          expandedSparklineGranularityMinutes: 60,
          expandedSparklineTimeZone: 'America/Sao_Paulo',
          sparklineRange: {
            monitoredDays: 2,
            recentDays: 3,
            oldWeekDays: 10,
            monitoredPreset: '12h',
            recentPreset: 'all',
            oldWeekPreset: '7d',
            tokenDaysByAddress: {
              TokenRange111111111111111111111111111111111: 1,
            },
            tokenPresetByAddress: {
              TokenPreset11111111111111111111111111111111: 'all',
            },
          },
          livePanelLayout: {
            order: ['alerts', 'monitored', 'pumpfun'],
            spans: {
              monitored: 2,
              pumpfun: 1,
              alerts: 3,
            },
            heights: {
              monitored: 760,
              alerts: 980,
            },
          },
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.uiPrefs.manualStarredOnly, true);
    assert.equal(response.body.uiPrefs.manualFolderDeleteWarningDismissed, true);
    assert.deepEqual(response.body.uiPrefs.chainFilters.enabledChains, ['solana']);
    assert.equal(response.body.uiPrefs.monitoredPerPage, 50);
    assert.equal(response.body.uiPrefs.expandedSparklineGranularityMinutes, 60);
    assert.equal(response.body.uiPrefs.expandedSparklineTimeZone, 'America/Sao_Paulo');
    assert.deepEqual(response.body.uiPrefs.sparklineRange, {
      monitoredDays: 2,
      recentDays: 3,
      oldWeekDays: 10,
      monitoredPreset: '12h',
      recentPreset: 'all',
      oldWeekPreset: '7d',
      tokenDaysByAddress: {
        TokenRange111111111111111111111111111111111: 1,
      },
      tokenPresetByAddress: {
        TokenPreset11111111111111111111111111111111: 'all',
      },
    });
    assert.deepEqual(response.body.uiPrefs.enabledTradeTerminals, ['photon', 'bullx']);
    assert.deepEqual(response.body.uiPrefs.livePanelLayout, {
      order: ['alerts', 'monitored', 'pumpfun'],
      spans: {
        monitored: 2,
        pumpfun: 1,
        alerts: 3,
      },
      heights: {
        monitored: 760,
        alerts: 980,
      },
    });
  });

  it('invalidates the alert profile only when enabled chains change', async () => {
    const { rows } = await db.query(
      "SELECT id FROM users WHERE role = 'user' ORDER BY id LIMIT 1",
    );
    const userId = rows[0].id;
    const initialProfile = await userAlertProfileCache.refreshUserProfile(userId);
    assert.deepEqual(initialProfile.enabledChains, ['solana']);

    const chainResponse = await request(app)
      .patch('/api/config/ui-prefs')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        uiPrefs: {
          chainFilters: {
            enabledChains: ['solana', 'robinhood'],
            radarChains: ['solana', 'robinhood'],
            alertFeedChains: ['solana', 'robinhood'],
            browserNotificationChains: ['solana'],
          },
        },
      });

    assert.equal(chainResponse.status, 200);
    assert.equal(userAlertProfileCache.__private.getCachedUserProfile(userId), null);
    const refreshed = await userAlertProfileCache.refreshUserProfile(userId);
    assert.deepEqual(refreshed.enabledChains, ['solana', 'robinhood']);

    const unrelatedResponse = await request(app)
      .patch('/api/config/ui-prefs')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ uiPrefs: { manualStarredOnly: false } });

    assert.equal(unrelatedResponse.status, 200);
    assert.equal(
      userAlertProfileCache.__private.getCachedUserProfile(userId),
      refreshed,
    );
    userAlertProfileCache.invalidateUserProfile(userId);
  });

  it('keeps config data isolated per user', async () => {
    const setupResponses = await Promise.all([
      request(app)
        .post('/api/config/tokens')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ address: VALID_ADDR_1, label: 'Isolation manual' }),
      request(app)
        .post('/api/config/blocklist')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ address: VALID_ADDR_1, label: 'Isolation block' }),
      request(app)
        .post('/api/config/starred')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ address: VALID_ADDR_1 }),
    ]);
    assert.deepEqual(setupResponses.map((response) => response.status), [201, 201, 201]);

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

    const cleanupResponses = await Promise.all([
      request(app)
        .delete(`/api/config/tokens/${VALID_ADDR_1}`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app)
        .delete(`/api/config/blocklist/${VALID_ADDR_1}`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app)
        .delete(`/api/config/starred/${VALID_ADDR_1}`)
        .set('Authorization', `Bearer ${userToken}`),
    ]);
    assert.deepEqual(cleanupResponses.map((response) => response.status), [200, 200, 200]);
  });
});
