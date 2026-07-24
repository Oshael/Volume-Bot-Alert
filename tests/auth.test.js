const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: createSocketClient } = require('../frontend/node_modules/socket.io-client');

function request(method, path, { body, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: process.env.TEST_PORT || 3099,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getQueryToken(actionUrl) {
  assert.ok(actionUrl, 'Expected actionUrl in email debug payload');
  const parsed = new URL(actionUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token, 'Expected token query param in actionUrl');
  return token;
}

function getCookieAttribute(cookieValue, attributeName) {
  const prefix = `${String(attributeName || '').trim().toLowerCase()}=`;
  for (const part of String(cookieValue || '').split(';')) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
}

function findSetCookie(headers, cookieName) {
  const prefix = `${cookieName}=`;
  const values = Array.isArray(headers?.['set-cookie']) ? headers['set-cookie'] : [];
  return String(values.find((entry) => String(entry || '').startsWith(prefix)) || '').split(';')[0];
}

async function completeGoogleLogin(identity, returnTo = '/alerts') {
  const start = await request(
    'GET',
    `/api/auth/social/google/login/start?returnTo=${encodeURIComponent(returnTo)}`
  );
  assert.equal(start.status, 302);
  const state = new URL(String(start.headers.location || '')).searchParams.get('state');
  const socialCookie = findSetCookie(start.headers, 'volume_alert_social_login');
  assert.ok(state);
  assert.ok(socialCookie);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const targetUrl = String(url || '');
    if (targetUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ access_token: 'google-direct-login-access-token' });
        },
      };
    }
    if (targetUrl === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return {
        ok: true,
        async text() {
          return JSON.stringify(identity);
        },
      };
    }
    throw new Error(`Unexpected fetch call in direct Google login test: ${targetUrl}`);
  };

  try {
    return await request(
      'GET',
      `/api/auth/social/google/login/callback?code=test-google-direct-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: socialCookie } }
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function createBearerSessionForUser(user) {
  const crypto = require('crypto');
  const jwt = require('jsonwebtoken');
  const config = require('../config');
  const Session = require('../src/models/session');

  const sessionId = crypto.randomUUID();
  const token = jwt.sign(
    { userId: user.id, role: user.role, jti: sessionId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
  const decoded = jwt.decode(token);
  await Session.create({
    userId: user.id,
    token,
    ipAddress: '127.0.0.1',
    userAgent: 'auth-test',
    expiresAt: new Date(decoded.exp * 1000),
  });
  return token;
}

async function verifyEmailWithGrantedAccessFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.emailVerificationRequired, true);
  assert.ok(registerResponse.body.emailDebug?.actionUrl);
  assert.equal(new URL(registerResponse.body.emailDebug.actionUrl).pathname, '/auth/verify-email');

  const verificationToken = getQueryToken(registerResponse.body.emailDebug.actionUrl);
  const verifyResponse = await request('POST', '/api/auth/verify-email/confirm', {
    body: { token: verificationToken },
  });

  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyResponse.body.requiresPreAccess, undefined);
  assert.equal(verifyResponse.body.user.isEmailVerified, true);
  assert.equal(verifyResponse.body.access?.hasProductAccess, true);
  assert.ok(verifyResponse.body.token);
  assert.match(String(verifyResponse.body.message || ''), /Email verified successfully/i);
  return verifyResponse;
}

async function completeLogin(email, password) {
  const loginResponse = await request('POST', '/api/auth/login', {
    body: { email, password },
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.otpRequired, true);
  assert.ok(loginResponse.body.challengeToken);
  assert.ok(loginResponse.body.emailDebug?.otpCode);

  const verifyResponse = await request('POST', '/api/auth/login-otp/verify', {
    body: {
      challengeToken: loginResponse.body.challengeToken,
      code: loginResponse.body.emailDebug.otpCode,
    },
  });

  assert.equal(verifyResponse.status, 200);
  assert.ok(verifyResponse.body.token);

  return {
    loginResponse,
    verifyResponse,
    token: verifyResponse.body.token,
  };
}

async function startLogin(email, password) {
  const loginResponse = await request('POST', '/api/auth/login', {
    body: { email, password },
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.otpRequired, true);
  assert.ok(loginResponse.body.challengeToken);
  assert.ok(loginResponse.body.emailDebug?.otpCode);

  return loginResponse;
}

async function verifyLoginOtp(challengeToken, code) {
  return request('POST', '/api/auth/login-otp/verify', {
    body: {
      challengeToken,
      code,
    },
  });
}

function connectSocket(url, token) {
  return new Promise((resolve) => {
    const client = createSocketClient(url, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 2000,
    });

    const timer = setTimeout(() => {
      try { client.close(); } catch {}
      resolve({ connected: false, error: 'timeout' });
    }, 2500);

    client.on('connect', () => {
      clearTimeout(timer);
      resolve({ connected: true, client });
    });

    client.on('connect_error', (error) => {
      clearTimeout(timer);
      try { client.close(); } catch {}
      resolve({ connected: false, error: error.message });
    });
  });
}

async function ensureAccessSchema(pool) {
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
    `CREATE TABLE IF NOT EXISTS user_social_identities (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(32) NOT NULL,
      provider_user_id VARCHAR(255) NOT NULL,
      provider_email VARCHAR(255),
      provider_email_verified BOOLEAN NOT NULL DEFAULT false,
      provider_display_name VARCHAR(255),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];
  for (const statement of statements) {
    await pool.query(statement);
  }
}

describe('Volume Alert Server auth flow', () => {
  let server;
  let adminToken;
  let userToken;
  let preAccessToken;
  let inviteCode;
  let socketHub;
  let originalSolPriceStart;
  let originalSolPriceStop;
  let originalSolPriceGetPrice;
  let originalSolPriceGetStatus;
  let originalPumpStart;
  let originalPumpStop;
  let originalPumpGetStatus;
  let originalPumpSubscribe;
  let originalPumpUnsubscribe;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3099';
    process.env.TEST_PORT = '3099';
    process.env.AUTH_SESSION_EXPIRES_IN = '30d';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '50';
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_PROVIDER = 'local';
    process.env.EMAIL_FROM = 'tests@trendscope.local';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-test-client-secret';
    process.env.DISCORD_OAUTH_CLIENT_ID = 'discord-test-client-id';
    process.env.DISCORD_OAUTH_CLIENT_SECRET = 'discord-test-client-secret';

    const { pool } = require('../src/models/db');
    const { assertUsingTestDatabase } = require('./helpers/test-db');

    await assertUsingTestDatabase(pool);
    await ensureAccessSchema(pool);
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM invites');
    await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});

    const { startServer } = require('../src/server');
    server = startServer(3099);
    await new Promise((resolve) => setTimeout(resolve, 500));

    socketHub = require('../src/services/socket-hub');
    const solPrice = require('../src/services/sol-price');
    const pumpfun = require('../src/services/pumpfun-ws');

    originalSolPriceStart = solPrice.start;
    originalSolPriceStop = solPrice.stop;
    originalSolPriceGetPrice = solPrice.getPrice;
    originalSolPriceGetStatus = solPrice.getStatus;
    originalPumpStart = pumpfun.start;
    originalPumpStop = pumpfun.stop;
    originalPumpGetStatus = pumpfun.getStatus;
    originalPumpSubscribe = pumpfun.subscribeToken;
    originalPumpUnsubscribe = pumpfun.unsubscribeToken;

    solPrice.start = () => {};
    solPrice.stop = () => {};
    solPrice.getPrice = () => 100;
    solPrice.getStatus = () => ({ running: false });
    pumpfun.start = () => {};
    pumpfun.stop = () => {};
    pumpfun.getStatus = () => ({ connected: false });
    pumpfun.subscribeToken = () => {};
    pumpfun.unsubscribeToken = () => {};

    socketHub.init(server);
  });

  after(async () => {
    socketHub.stop();
    const solPrice = require('../src/services/sol-price');
    const pumpfun = require('../src/services/pumpfun-ws');
    solPrice.start = originalSolPriceStart;
    solPrice.stop = originalSolPriceStop;
    solPrice.getPrice = originalSolPriceGetPrice;
    solPrice.getStatus = originalSolPriceGetStatus;
    pumpfun.start = originalPumpStart;
    pumpfun.stop = originalPumpStop;
    pumpfun.getStatus = originalPumpGetStatus;
    pumpfun.subscribeToken = originalPumpSubscribe;
    pumpfun.unsubscribeToken = originalPumpUnsubscribe;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const { pool } = require('../src/models/db');
    await pool.end();
  });

  describe('Health Check', () => {
    it('GET /api/health returns ok', async () => {
      const res = await request('GET', '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.db.connected);
      assert.equal(res.body.runtime.role, 'background');
      assert.equal(res.body.runtime.socketEnabled, false);
      assert.equal(res.body.runtime.backgroundJobsEnabled, true);
      assert.deepEqual(res.body.runtime.workerGroupsRequested, ['all']);
      assert.deepEqual(res.body.runtime.workerGroupsActive, ['core', 'market', 'maintenance']);
      assert.deepEqual(
        res.body.runtime.workerGroupsSkipped,
        ['robinhood', 'robinhood-backfill']
      );
    });

    it('GET /api/health sanitizes DB failures', async () => {
      const { pool } = require('../src/models/db');
      const healthRoute = require('../src/routes/health');
      const originalQuery = pool.query;

      pool.query = async () => {
        throw new Error('password authentication failed for user postgres');
      };
      healthRoute.__private.resetHealthCache();

      try {
        const res = await request('GET', '/api/health');
        assert.equal(res.status, 503);
        assert.equal(res.body.status, 'error');
        assert.equal(res.body.db.connected, false);
        assert.equal(res.body.error, 'Database unavailable');
        assert.equal(res.body.db.error, undefined);
        assert.equal(String(res.body.error || '').includes('password authentication failed'), false);
        assert.equal(JSON.stringify(res.body).includes('password authentication failed'), false);
      } finally {
        pool.query = originalQuery;
        healthRoute.__private.resetHealthCache();
      }
    });
  });

  describe('Bootstrap Invite', () => {
    it('creates bootstrap invite directly in DB', async () => {
      const { query } = require('../src/models/db');
      inviteCode = 'TESTBOOTSTRAP01';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, grant_access_days, grant_access_source, expires_at)
         VALUES ($1, NULL, 5, 30, 'invite', NOW() + INTERVAL '24 hours')`,
        [inviteCode]
      );
    });

    it('validates bootstrap invite', async () => {
      const res = await request('GET', `/api/invites/validate/${inviteCode}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, true);
    });
  });

  describe('Registration', () => {
    it('fails without invite code', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'test@test.com', password: 'password123' },
      });
      assert.equal(res.status, 400);
    });

    it('fails with invalid invite code', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'test@test.com', password: 'password123', inviteCode: 'INVALID' },
      });
      assert.equal(res.status, 400);
    });

    it('fails with short password', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'test@test.com', password: '123', inviteCode },
      });
      assert.equal(res.status, 400);
    });

    it('fails with short username', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'ab', email: 'test@test.com', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 400);
    });

    it('fails with invalid email', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'not-an-email', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 400);
    });

    it('registers admin user without auto-login and verifies email', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'admin_user', email: 'admin@test.com', password: 'adminpass123', inviteCode },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.token, null);
      assert.equal(res.body.user.username, 'admin_user');
      assert.equal(res.body.user.isEmailVerified, false);
      await verifyEmailWithGrantedAccessFromRegisterResponse(res);

      const { query } = require('../src/models/db');
      await query("UPDATE users SET role = 'admin' WHERE username = 'admin_user'");
    });

    it('registers regular user without auto-login and verifies email', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'regular_user', email: 'user@test.com', password: 'userpass123', inviteCode },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.token, null);
      assert.equal(res.body.user.username, 'regular_user');
      await verifyEmailWithGrantedAccessFromRegisterResponse(res);
    });

    it('verifies email into pre-access when the invite grants no active access', async () => {
      const { query } = require('../src/models/db');
      const code = 'NOGRANT00000001';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, grant_access_days, grant_access_source, expires_at)
         VALUES ($1, NULL, 1, NULL, 'invite', NOW() + INTERVAL '24 hours')`,
        [code]
      );

      const register = await request('POST', '/api/auth/register', {
        body: {
          username: 'nogrant_user',
          email: 'nogrant@test.com',
          password: 'nograntpass123',
          inviteCode: code,
        },
      });
      assert.equal(register.status, 201);

      const verificationToken = getQueryToken(register.body.emailDebug.actionUrl);
      const verify = await request('POST', '/api/auth/verify-email/confirm', {
        body: { token: verificationToken },
      });

      assert.equal(verify.status, 200);
      assert.equal(verify.body.requiresPreAccess, true);
      assert.equal(verify.body.redirectPath, '/access');
      assert.equal(verify.body.user.isEmailVerified, true);
      assert.equal(verify.body.access?.hasProductAccess, false);
      assert.ok(verify.body.preAccessToken);
    });

    it('fails with duplicate username', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'admin_user', email: 'new@test.com', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 409);
    });

    it('fails with duplicate email', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'new_user', email: 'admin@test.com', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 409);
    });

    it('does not consume invite when registration fails with duplicate username', async () => {
      const { query } = require('../src/models/db');
      const code = 'DUPENAME000001';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, grant_access_days, grant_access_source, expires_at)
         VALUES ($1, NULL, 1, 30, 'invite', NOW() + INTERVAL '24 hours')`,
        [code]
      );

      const before = await query('SELECT use_count FROM invites WHERE code = $1', [code]);
      assert.equal(before.rows[0].use_count, 0);

      const res = await request('POST', '/api/auth/register', {
        body: { username: 'admin_user', email: 'dup-user@test.com', password: 'password123', inviteCode: code },
      });
      assert.equal(res.status, 409);

      const after = await query('SELECT use_count FROM invites WHERE code = $1', [code]);
      assert.equal(after.rows[0].use_count, 0);
    });

    it('does not consume invite when registration fails with duplicate email', async () => {
      const { query } = require('../src/models/db');
      const code = 'DUPEMAIL000001';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, grant_access_days, grant_access_source, expires_at)
         VALUES ($1, NULL, 1, 30, 'invite', NOW() + INTERVAL '24 hours')`,
        [code]
      );

      const before = await query('SELECT use_count FROM invites WHERE code = $1', [code]);
      assert.equal(before.rows[0].use_count, 0);

      const res = await request('POST', '/api/auth/register', {
        body: { username: 'dup_mail_user', email: 'admin@test.com', password: 'password123', inviteCode: code },
      });
      assert.equal(res.status, 409);

      const after = await query('SELECT use_count FROM invites WHERE code = $1', [code]);
      assert.equal(after.rows[0].use_count, 0);
    });
  });

  describe('Login', () => {
    it('starts login with OTP and completes admin login successfully', async () => {
      const auth = await completeLogin('admin@test.com', 'adminpass123');
      assert.equal(auth.loginResponse.body.token, undefined);
      adminToken = auth.token;
    });

    it('issues a persistent auth cookie on completed login', async () => {
      const auth = await completeLogin('admin@test.com', 'adminpass123');
      const setCookie = auth.verifyResponse.headers['set-cookie'];
      assert.ok(Array.isArray(setCookie) && setCookie.length > 0, 'expected auth cookie');
      const authCookie = setCookie.find((value) => value.startsWith('volume_alert_session='));
      assert.ok(authCookie, 'expected volume_alert_session cookie');

      const expiresValue = getCookieAttribute(authCookie, 'Expires');
      assert.ok(expiresValue, 'expected persistent Expires attribute');

      const expiresAt = new Date(expiresValue);
      assert.ok(Number.isFinite(expiresAt.getTime()), 'expected valid cookie expiry date');
      assert.ok(
        expiresAt.getTime() - Date.now() > (25 * 24 * 60 * 60 * 1000),
        `expected long-lived cookie, got expiry ${expiresAt.toISOString()}`
      );
    });

    it('fails with wrong password', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'admin@test.com', password: 'wrongpassword' },
      });
      assert.equal(res.status, 401);
    });

    it('fails with non-existent email', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'nobody@test.com', password: 'password123' },
      });
      assert.equal(res.status, 401);
    });

    it('fails with missing fields', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'admin@test.com' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects malformed OTP challenge tokens before lookup', async () => {
      const res = await request('POST', '/api/auth/login-otp/verify', {
        body: { challengeToken: 'not-a-real-token', code: '123456' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Authentication', () => {
    it('GET /api/auth/me works with valid token', async () => {
      const res = await request('GET', '/api/auth/me', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'admin_user');
      assert.equal(res.body.user.role, 'admin');
    });

    it('fails without token', async () => {
      const res = await request('GET', '/api/auth/me');
      assert.equal(res.status, 401);
    });

    it('fails with invalid token', async () => {
      const res = await request('GET', '/api/auth/me', { token: 'invalid.token.here' });
      assert.equal(res.status, 401);
    });
  });

  describe('Invites', () => {
    let newInviteCode;
    let newInviteId;

    it('admin creates invite', async () => {
      const res = await request('POST', '/api/invites', {
        token: adminToken,
        body: { maxUses: 3, expiryHours: 48 },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.invite.code);
      assert.equal(res.body.invite.max_uses, 3);
      newInviteCode = res.body.invite.code;
      newInviteId = res.body.invite.id;
    });

    it('regular user creates invite with defaults', async () => {
      if (!userToken) {
        userToken = (await completeLogin('user@test.com', 'userpass123')).token;
      }

      const res = await request('POST', '/api/invites', {
        token: userToken,
        body: { maxUses: 100 },
      });
      assert.equal(res.status, 201);
    });

    it('validates the new invite code', async () => {
      const res = await request('GET', `/api/invites/validate/${newInviteCode}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, true);
    });

    it('lists my invites', async () => {
      const res = await request('GET', '/api/invites', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length > 0);
    });

    it('admin lists all invites', async () => {
      const res = await request('GET', '/api/invites/all', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length > 0);
    });

    it('regular user cannot list all invites', async () => {
      const res = await request('GET', '/api/invites/all', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('revokes an invite', async () => {
      const res = await request('DELETE', `/api/invites/${newInviteId}`, { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.invite.is_revoked, true);
    });

    it('validates revoked invite returns invalid', async () => {
      const res = await request('GET', `/api/invites/validate/${newInviteCode}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, false);
    });

    it('admin invite params are clamped to safe minimums at creation', async () => {
      const res = await request('POST', '/api/invites', {
        token: adminToken,
        body: { maxUses: -5, expiryHours: 0 },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.invite.max_uses, 1);
    });
  });

  describe('Session Management', () => {
    it('logout revokes only current session', async () => {
      const first = await completeLogin('user@test.com', 'userpass123');
      const second = await completeLogin('user@test.com', 'userpass123');

      const logoutRes = await request('POST', '/api/auth/logout', { token: first.token });
      assert.equal(logoutRes.status, 200);

      const meLoggedOut = await request('GET', '/api/auth/me', { token: first.token });
      const meStillValid = await request('GET', '/api/auth/me', { token: second.token });
      assert.equal(meLoggedOut.status, 401);
      assert.equal(meStillValid.status, 200);

      userToken = second.token;
    });

    it('logout-all revokes all sessions', async () => {
      const login1 = await completeLogin('user@test.com', 'userpass123');
      const login2 = await completeLogin('user@test.com', 'userpass123');

      const res = await request('POST', '/api/auth/logout-all', { token: login1.token });
      assert.equal(res.status, 200);

      const me1 = await request('GET', '/api/auth/me', { token: login1.token });
      const me2 = await request('GET', '/api/auth/me', { token: login2.token });
      assert.equal(me1.status, 401);
      assert.equal(me2.status, 401);
    });
  });

  describe('Password Change', () => {
    it('changes password successfully and revokes old sessions', async () => {
      const login = await completeLogin('user@test.com', 'userpass123');

      const res = await request('POST', '/api/auth/change-password', {
        token: login.token,
        body: { currentPassword: 'userpass123', newPassword: 'newpass456' },
      });
      assert.equal(res.status, 200);

      const oldLogin = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(oldLogin.status, 401);

      const newLogin = await completeLogin('user@test.com', 'newpass456');
      userToken = newLogin.token;
    });

    it('fails with wrong current password', async () => {
      const res = await request('POST', '/api/auth/change-password', {
        token: userToken,
        body: { currentPassword: 'wrongpass', newPassword: 'anotherpass' },
      });
      assert.equal(res.status, 401);
    });
  });

  describe('Action Token Hardening', () => {
    it('rejects malformed email verification tokens', async () => {
      const res = await request('POST', '/api/auth/verify-email/confirm', {
        body: { token: 'definitely-not-a-real-token' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects malformed password reset tokens', async () => {
      const res = await request('POST', '/api/auth/password-reset/confirm', {
        body: { token: 'still-not-a-real-token', newPassword: 'anotherpass123' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Deactivated User', () => {
    it('admin deactivates a user', async () => {
      const { query } = require('../src/models/db');
      await query("UPDATE users SET is_active = false WHERE username = 'regular_user'");
    });

    it('deactivated user cannot login', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'newpass456' },
      });
      assert.equal(res.status, 403);
    });

    it('reactivates user for further tests', async () => {
      const { query } = require('../src/models/db');
      await query("UPDATE users SET is_active = true WHERE username = 'regular_user'");
    });
  });

  describe('Access Control', () => {
    it('returns account access snapshot for an authenticated user', async () => {
      const login = await completeLogin('user@test.com', 'newpass456');
      userToken = login.token;

      const res = await request('GET', '/api/account/access', { token: userToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.accessStatus, 'active');
      assert.equal(res.body.hasProductAccess, true);
      assert.equal(res.body.isExpired, false);
    });

    it('updates the authenticated account username without changing email verification state', async () => {
      const res = await request('PATCH', '/api/account/profile', {
        token: userToken,
        body: { username: 'regular_user_renamed' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'regular_user_renamed');
      assert.equal(res.body.user.email, 'user@test.com');
      assert.equal(res.body.user.isEmailVerified, true);

      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, 'regular_user_renamed');

      await require('../src/models/db').query(
        `UPDATE users SET username = 'regular_user' WHERE email = 'user@test.com'`
      );
    });

    it('blocks adding email and password to a non-wallet account', async () => {
      const res = await request('PATCH', '/api/account/profile', {
        token: userToken,
        body: {
          username: 'regular_user',
          email: 'regular-new@test.com',
          password: 'regularnewpass123',
          confirmPassword: 'regularnewpass123',
        },
      });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /wallet-only/i);
    });

    it('completes a wallet-only account and requires email verification before email login', async () => {
      const User = require('../src/models/user');
      const walletUser = await User.createWalletOnly({
        username: 'user_abcd',
        walletAddress: 'WalletProfileTest1111111111111111111111111111',
      });
      await require('../src/models/db').query(
        `UPDATE users
         SET access_status = 'active',
             access_expires_at = NOW() + INTERVAL '1 hour',
             access_source = 'manual'
         WHERE id = $1`,
        [walletUser.id]
      );
      const walletToken = await createBearerSessionForUser(walletUser);

      const res = await request('PATCH', '/api/account/profile', {
        token: walletToken,
        body: {
          username: 'wallet_profile_user',
          email: 'wallet-profile@test.com',
          password: 'walletpass123',
          confirmPassword: 'walletpass123',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.emailVerificationRequired, true);
      assert.equal(res.body.user.username, 'wallet_profile_user');
      assert.equal(res.body.user.email, 'wallet-profile@test.com');
      assert.equal(res.body.user.isEmailVerified, false);
      assert.ok(res.body.emailDebug?.actionUrl);

      const earlyLogin = await request('POST', '/api/auth/login', {
        body: { email: 'wallet-profile@test.com', password: 'walletpass123' },
      });
      assert.equal(earlyLogin.status, 403);

      const verificationToken = getQueryToken(res.body.emailDebug.actionUrl);
      const verifyResponse = await request('POST', '/api/auth/verify-email/confirm', {
        body: { token: verificationToken },
      });
      assert.equal(verifyResponse.status, 200);
      assert.equal(verifyResponse.body.user.isEmailVerified, true);

      const login = await completeLogin('wallet-profile@test.com', 'walletpass123');
      const me = await request('GET', '/api/auth/me', { token: login.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, 'wallet_profile_user');
      assert.equal(me.body.user.email, 'wallet-profile@test.com');
      assert.equal(me.body.user.isEmailVerified, true);
    });

    it('returns social identity provider status for an authenticated user', async () => {
      const res = await request('GET', '/api/account/identities', { token: userToken });
      assert.equal(res.status, 200);
      assert.equal(Array.isArray(res.body.providers), true);
      assert.deepEqual(
        res.body.providers.map((entry) => ({
          provider: entry.provider,
          configured: entry.configured,
          linked: entry.linked,
        })),
        [
          { provider: 'google', configured: true, linked: false },
          { provider: 'discord', configured: true, linked: false },
        ]
      );
    });

    it('returns linked provider details when an identity is already attached', async () => {
      const { query } = require('../src/models/db');
      await query(
        `INSERT INTO user_social_identities (
          user_id,
          provider,
          provider_user_id,
          provider_email,
          provider_email_verified,
          provider_display_name
        )
        VALUES (
          (SELECT id FROM users WHERE username = 'regular_user'),
          'google',
          'google-user-123',
          'user@test.com',
          true,
          'Regular User Google'
        )`
      );

      const res = await request('GET', '/api/account/identities', { token: userToken });
      assert.equal(res.status, 200);
      const google = res.body.providers.find((entry) => entry.provider === 'google');
      const discord = res.body.providers.find((entry) => entry.provider === 'discord');
      assert.equal(google?.linked, true);
      assert.equal(google?.providerEmail, 'user@test.com');
      assert.equal(google?.providerEmailVerified, true);
      assert.equal(google?.providerDisplayName, 'Regular User Google');
      assert.ok(google?.linkedAt);
      assert.equal(discord?.linked, false);
    });

    it('returns linked identities from account-security for an authenticated session', async () => {
      const res = await request('GET', '/api/account-security/identities', { token: userToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.scope, 'authenticated');
      assert.equal(Array.isArray(res.body.providers), true);
      const google = res.body.providers.find((entry) => entry.provider === 'google');
      assert.equal(google?.linked, true);
    });

    it('starts Google linking and completes callback into the current account', async () => {
      const login = await startLogin('user@test.com', 'newpass456');
      const otp = await verifyLoginOtp(login.body.challengeToken, login.body.emailDebug.otpCode);
      assert.equal(otp.status, 200);
      const authCookie = String(otp.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_session=')) || '').split(';')[0];
      assert.ok(authCookie);

      const start = await request('GET', '/api/auth/social/google/start?returnTo=%2Fmonitor', {
        headers: { Cookie: authCookie },
      });
      assert.equal(start.status, 302);
      assert.match(String(start.headers.location || ''), /^https:\/\/accounts\.google\.com\//);
      const state = new URL(String(start.headers.location)).searchParams.get('state');
      assert.ok(state);

      const socialCookie = String(start.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_social_link=')) || '').split(';')[0];
      assert.ok(socialCookie);

      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const targetUrl = String(url || '');
        if (targetUrl === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({ access_token: 'google-access-token' });
            },
          };
        }

        if (targetUrl === 'https://openidconnect.googleapis.com/v1/userinfo') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                sub: 'google-user-999',
                email: 'user@test.com',
                email_verified: true,
                name: 'Regular User Google',
              });
            },
          };
        }

        throw new Error(`Unexpected fetch call in social linking test: ${targetUrl}`);
      };

      try {
        const callback = await request('GET', `/api/auth/social/google/callback?code=test-google-code&state=${encodeURIComponent(state)}`, {
          headers: {
            Cookie: `${authCookie}; ${socialCookie}`,
          },
        });
        assert.equal(callback.status, 200);
        assert.match(String(callback.body || ''), /<script src="\/api\/auth\/social\/popup-bridge\.js" defer><\/script>/);
        assert.match(String(callback.body || ''), /data-provider="google"/);
        assert.match(String(callback.body || ''), /data-status="success"/);
        assert.match(String(callback.body || ''), /\/monitor\?socialLink=success&amp;socialProvider=google/);
      } finally {
        global.fetch = originalFetch;
      }

      const identities = await request('GET', '/api/account/identities', { token: otp.body.token });
      const google = identities.body.providers.find((entry) => entry.provider === 'google');
      assert.equal(google?.linked, true);
      assert.equal(google?.providerEmail, 'user@test.com');
      assert.equal(google?.providerDisplayName, 'Regular User Google');
    });

    it('blocks linking when provider email belongs to a different existing account', async () => {
      const login = await startLogin('user@test.com', 'newpass456');
      const otp = await verifyLoginOtp(login.body.challengeToken, login.body.emailDebug.otpCode);
      assert.equal(otp.status, 200);
      const authCookie = String(otp.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_session=')) || '').split(';')[0];
      assert.ok(authCookie);

      const start = await request('GET', '/api/auth/social/discord/start?returnTo=%2Falerts', {
        headers: { Cookie: authCookie },
      });
      assert.equal(start.status, 302);
      assert.match(String(start.headers.location || ''), /^https:\/\/discord\.com\//);
      const state = new URL(String(start.headers.location)).searchParams.get('state');
      assert.ok(state);

      const socialCookie = String(start.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_social_link=')) || '').split(';')[0];
      assert.ok(socialCookie);

      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const targetUrl = String(url || '');
        if (targetUrl === 'https://discord.com/api/oauth2/token') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({ access_token: 'discord-access-token' });
            },
          };
        }

        if (targetUrl === 'https://discord.com/api/users/@me') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                id: 'discord-user-222',
                email: 'admin@test.com',
                verified: true,
                username: 'discord-admin-clash',
                global_name: 'Discord Clash',
              });
            },
          };
        }

        throw new Error(`Unexpected fetch call in social linking conflict test: ${targetUrl}`);
      };

      try {
        const callback = await request('GET', `/api/auth/social/discord/callback?code=test-discord-code&state=${encodeURIComponent(state)}`, {
          headers: {
            Cookie: `${authCookie}; ${socialCookie}`,
          },
        });
        assert.equal(callback.status, 200);
        assert.match(String(callback.body || ''), /<script src="\/api\/auth\/social\/popup-bridge\.js" defer><\/script>/);
        assert.match(String(callback.body || ''), /data-provider="discord"/);
        assert.match(String(callback.body || ''), /data-status="email_conflict"/);
        assert.match(String(callback.body || ''), /\/alerts\?socialLink=email_conflict&amp;socialProvider=discord/);
      } finally {
        global.fetch = originalFetch;
      }

      const identities = await request('GET', '/api/account/identities', { token: otp.body.token });
      const discord = identities.body.providers.find((entry) => entry.provider === 'discord');
      assert.equal(discord?.linked, false);
    });

    it('signs in with Google without OTP when the identity is already linked', async () => {
      const { query } = require('../src/models/db');
      await query(
        `DELETE FROM user_social_identities
         WHERE user_id = (SELECT id FROM users WHERE username = 'regular_user')
           AND provider = 'google'`
      );
      await query(
        `INSERT INTO user_social_identities (
          user_id,
          provider,
          provider_user_id,
          provider_email,
          provider_email_verified,
          provider_display_name
        )
        VALUES (
          (SELECT id FROM users WHERE username = 'regular_user'),
          'google',
          'google-login-user-123',
          'user@test.com',
          true,
          'Regular User Google Login'
        )`
      );

      const start = await request('GET', '/api/auth/social/google/login/start?returnTo=%2Fmonitor');
      assert.equal(start.status, 302);
      assert.match(String(start.headers.location || ''), /^https:\/\/accounts\.google\.com\//);
      const startRedirect = new URL(String(start.headers.location));
      const state = startRedirect.searchParams.get('state');
      assert.ok(state);
      assert.equal(startRedirect.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/social/google/login/callback');

      const socialCookie = String(start.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_social_login=')) || '').split(';')[0];
      assert.ok(socialCookie);

      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const targetUrl = String(url || '');
        if (targetUrl === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({ access_token: 'google-login-access-token' });
            },
          };
        }

        if (targetUrl === 'https://openidconnect.googleapis.com/v1/userinfo') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                sub: 'google-login-user-123',
                email: 'user@test.com',
                email_verified: true,
                name: 'Regular User Google Login',
              });
            },
          };
        }

        throw new Error(`Unexpected fetch call in social login test: ${targetUrl}`);
      };

      try {
        const callback = await request('GET', `/api/auth/social/google/login/callback?code=test-google-login-code&state=${encodeURIComponent(state)}`, {
          headers: {
            Cookie: socialCookie,
          },
        });
        assert.equal(callback.status, 302);
        const redirect = new URL(String(callback.headers.location || ''));
        assert.equal(redirect.pathname, '/monitor');
        assert.equal(redirect.searchParams.get('socialLogin'), 'success');
        assert.equal(redirect.searchParams.get('socialProvider'), 'google');

        const authCookie = String(callback.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_session=')) || '').split(';')[0];
        assert.ok(authCookie);

        const me = await request('GET', '/api/auth/me', {
          headers: {
            Cookie: authCookie,
          },
        });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.email, 'user@test.com');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('creates a new verified account from Google login and redirects to pre-access billing', async () => {
      const callback = await completeGoogleLogin({
        sub: 'google-direct-user-001',
        email: 'new.oauth-user@test.com',
        email_verified: true,
        name: 'New OAuth User',
      });

      assert.equal(callback.status, 302);
      const redirect = new URL(String(callback.headers.location || ''));
      assert.equal(redirect.pathname, '/access');
      assert.equal(redirect.searchParams.get('socialLogin'), 'success');
      assert.equal(redirect.searchParams.get('socialProvider'), 'google');

      const preAccessCookie = findSetCookie(callback.headers, 'volume_alert_pre_access');
      assert.ok(preAccessCookie);
      const me = await request('GET', '/api/pre-access/me', {
        headers: { Cookie: preAccessCookie },
      });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, 'new_oauth_user');
      assert.equal(me.body.user.email, 'new.oauth-user@test.com');
      assert.equal(me.body.user.isEmailVerified, true);
      assert.equal(me.body.access.hasProductAccess, false);
    });

    it('blocks automatic Google account merge when the verified email already exists', async () => {
      const callback = await completeGoogleLogin({
        sub: 'google-email-conflict-001',
        email: 'user@test.com',
        email_verified: true,
        name: 'Conflicting Google User',
      });

      assert.equal(callback.status, 302);
      const redirect = new URL(String(callback.headers.location || ''));
      assert.equal(redirect.pathname, '/alerts');
      assert.equal(redirect.searchParams.get('socialLogin'), 'email_conflict');

      const { query } = require('../src/models/db');
      const linked = await query(
        `SELECT id FROM user_social_identities
         WHERE provider = 'google' AND provider_user_id = 'google-email-conflict-001'`
      );
      assert.equal(linked.rowCount, 0);
    });

    it('blocks unlinking Google when it is the account only login method', async () => {
      const callback = await completeGoogleLogin({
        sub: 'google-only-login-001',
        email: 'google.only@test.com',
        email_verified: true,
        name: 'Google Only',
      });
      const preAccessCookie = findSetCookie(callback.headers, 'volume_alert_pre_access');
      assert.ok(preAccessCookie);

      const unlink = await request('POST', '/api/account-security/identities/google/unlink', {
        body: {},
        headers: {
          Cookie: preAccessCookie,
          Origin: 'http://localhost:5173',
        },
      });
      assert.equal(unlink.status, 409);
      assert.match(String(unlink.body.error || ''), /only sign-in method/i);
    });

    it('blocks social login when the provider identity is not linked to any account', async () => {
      const { query } = require('../src/models/db');
      await query(`DELETE FROM user_social_identities WHERE provider = 'discord' AND provider_user_id = 'discord-login-user-404'`);

      const start = await request('GET', '/api/auth/social/discord/login/start?returnTo=%2Falerts');
      assert.equal(start.status, 302);
      assert.match(String(start.headers.location || ''), /^https:\/\/discord\.com\//);
      const startRedirect = new URL(String(start.headers.location));
      const state = startRedirect.searchParams.get('state');
      assert.ok(state);
      assert.equal(startRedirect.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/social/discord/login/callback');

      const socialCookie = String(start.headers['set-cookie']?.find((entry) => entry.startsWith('volume_alert_social_login=')) || '').split(';')[0];
      assert.ok(socialCookie);

      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const targetUrl = String(url || '');
        if (targetUrl === 'https://discord.com/api/oauth2/token') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({ access_token: 'discord-login-access-token' });
            },
          };
        }

        if (targetUrl === 'https://discord.com/api/users/@me') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                id: 'discord-login-user-404',
                email: 'unlinked@test.com',
                verified: true,
                username: 'discord-unlinked',
                global_name: 'Discord Unlinked',
              });
            },
          };
        }

        throw new Error(`Unexpected fetch call in social login unlinked test: ${targetUrl}`);
      };

      try {
        const callback = await request('GET', `/api/auth/social/discord/login/callback?code=test-discord-login-code&state=${encodeURIComponent(state)}`, {
          headers: {
            Cookie: socialCookie,
          },
        });
        assert.equal(callback.status, 302);
        const redirect = new URL(String(callback.headers.location || ''));
        assert.equal(redirect.pathname, '/alerts');
        assert.equal(redirect.searchParams.get('socialLogin'), 'not_linked');
        assert.equal(redirect.searchParams.get('socialProvider'), 'discord');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('rejects unlink with the wrong current password and keeps the provider linked', async () => {
      const { query } = require('../src/models/db');
      await query(
        `DELETE FROM user_social_identities
         WHERE user_id = (SELECT id FROM users WHERE username = 'regular_user')
           AND provider = 'discord'`
      );
      await query(
        `INSERT INTO user_social_identities (
          user_id,
          provider,
          provider_user_id,
          provider_email,
          provider_email_verified,
          provider_display_name
        )
        VALUES (
          (SELECT id FROM users WHERE username = 'regular_user'),
          'discord',
          'discord-unlink-user-123',
          'user@test.com',
          true,
          'Regular User Discord Link'
        )`
      );

      const unlink = await request('POST', '/api/account-security/identities/discord/unlink', {
        token: userToken,
        body: { currentPassword: 'definitely-wrong-password' },
        headers: {
          Origin: 'http://localhost:5173',
        },
      });
      assert.equal(unlink.status, 401);
      assert.equal(unlink.body.error, 'Current password is incorrect');

      const identities = await request('GET', '/api/account-security/identities', { token: userToken });
      const discord = identities.body.providers.find((entry) => entry.provider === 'discord');
      assert.equal(discord?.linked, true);
    });

    it('unlinks a provider from account-security for an authenticated session', async () => {
      const unlink = await request('POST', '/api/account-security/identities/discord/unlink', {
        token: userToken,
        body: { currentPassword: 'newpass456' },
        headers: {
          Origin: 'http://localhost:5173',
        },
      });
      assert.equal(unlink.status, 200);
      assert.match(String(unlink.body.message || ''), /Discord identity unlinked successfully/i);
      const discord = unlink.body.providers.find((entry) => entry.provider === 'discord');
      assert.equal(discord?.linked, false);
      assert.equal(unlink.body.scope, 'authenticated');
    });

    it('rejects social login after authenticated unlink removed the provider identity', async () => {
      const start = await request('GET', '/api/auth/social/discord/login/start?returnTo=%2Flogin');
      assert.equal(start.status, 302);
      const startRedirect = new URL(String(start.headers.location || ''));
      const state = startRedirect.searchParams.get('state');
      assert.ok(state);

      const socialCookie = findSetCookie(start.headers, 'volume_alert_social_login');
      assert.ok(socialCookie);

      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const targetUrl = String(url || '');
        if (targetUrl === 'https://discord.com/api/oauth2/token') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({ access_token: 'discord-unlink-login-access-token' });
            },
          };
        }

        if (targetUrl === 'https://discord.com/api/users/@me') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                id: 'discord-unlink-user-123',
                email: 'user@test.com',
                verified: true,
                username: 'discord-unlinked-after-remove',
                global_name: 'Discord Unlinked After Remove',
              });
            },
          };
        }

        throw new Error(`Unexpected fetch call in social login after unlink test: ${targetUrl}`);
      };

      try {
        const callback = await request('GET', `/api/auth/social/discord/login/callback?code=test-discord-unlink-code&state=${encodeURIComponent(state)}`, {
          headers: {
            Cookie: socialCookie,
          },
        });
        assert.equal(callback.status, 302);
        const redirect = new URL(String(callback.headers.location || ''));
        assert.equal(redirect.pathname, '/login');
        assert.equal(redirect.searchParams.get('socialLogin'), 'not_linked');
        assert.equal(redirect.searchParams.get('socialProvider'), 'discord');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('expired access redirects login into the pre-access flow after OTP', async () => {
      const { query } = require('../src/models/db');
      await query(
        `UPDATE users
         SET access_status = 'active',
             access_expires_at = NOW() - INTERVAL '1 hour',
             access_source = 'admin',
             access_updated_at = NOW()
         WHERE username = 'regular_user'`
      );

      const login = await startLogin('user@test.com', 'newpass456');
      const res = await verifyLoginOtp(login.body.challengeToken, login.body.emailDebug.otpCode);
      assert.equal(res.status, 200);
      assert.equal(res.body.requiresPreAccess, true);
      assert.equal(res.body.redirectPath, '/access');
      assert.equal(res.body.message, 'Access payment required before entering the bot.');
      assert.equal(res.body.access?.hasProductAccess, false);
      assert.equal(res.body.access?.denialReason, 'Access expired');
      assert.ok(res.body.preAccessToken);
      preAccessToken = res.body.preAccessToken;
    });

    it('pre-access session exposes the restricted access state and blocks completion until paid', async () => {
      const me = await request('GET', '/api/pre-access/me', { token: preAccessToken });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, 'regular_user');
      assert.equal(me.body.access.hasProductAccess, false);
      assert.equal(me.body.access.denialReason, 'Access expired');

      const complete = await request('POST', '/api/pre-access/complete', {
        token: preAccessToken,
        headers: {
          origin: 'http://localhost:5173',
        },
      });
      assert.equal(complete.status, 409);
      assert.equal(complete.body.error, 'Payment confirmation still pending');
    });

    it('pre-access bearer sessions can read account-security identities', async () => {
      const res = await request('GET', '/api/account-security/identities', { token: preAccessToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.scope, 'pre_access');
      const google = res.body.providers.find((entry) => entry.provider === 'google');
      assert.equal(google?.linked, true);
    });

    it('pre-access sessions can unlink a provider with the current password', async () => {
      const unlink = await request('POST', '/api/account-security/identities/google/unlink', {
        token: preAccessToken,
        body: { currentPassword: 'newpass456' },
        headers: {
          Origin: 'http://localhost:5173',
        },
      });
      assert.equal(unlink.status, 200);
      assert.equal(unlink.body.scope, 'pre_access');
      const google = unlink.body.providers.find((entry) => entry.provider === 'google');
      assert.equal(google?.linked, false);
    });

    it('local login still works after pre-access unlink and remains in the billing-recovery flow', async () => {
      const login = await startLogin('user@test.com', 'newpass456');
      const res = await verifyLoginOtp(login.body.challengeToken, login.body.emailDebug.otpCode);
      assert.equal(res.status, 200);
      assert.equal(res.body.requiresPreAccess, true);
      assert.equal(res.body.redirectPath, '/access');
      assert.ok(res.body.preAccessToken);
    });

    it('revoked access is blocked from account-security read and unlink', async () => {
      const { query } = require('../src/models/db');
      await query(
        `UPDATE users
         SET access_status = 'revoked',
             access_expires_at = NULL,
             access_source = 'admin',
             access_updated_at = NOW()
         WHERE username = 'regular_user'`
      );

      const read = await request('GET', '/api/account-security/identities', { token: userToken });
      assert.equal(read.status, 403);
      assert.equal(read.body.error, 'Access revoked');

      const unlink = await request('POST', '/api/account-security/identities/google/unlink', {
        token: userToken,
        body: { currentPassword: 'newpass456' },
        headers: {
          Origin: 'http://localhost:5173',
        },
      });
      assert.equal(unlink.status, 403);
      assert.equal(unlink.body.error, 'Access revoked');

      await query(
        `UPDATE users
         SET access_status = 'active',
             access_expires_at = NOW() - INTERVAL '1 hour',
             access_source = 'admin',
             access_updated_at = NOW()
         WHERE username = 'regular_user'`
      );
    });

    it('expired access can still read account access status with an existing session', async () => {
      const res = await request('GET', '/api/account/access', { token: userToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.isExpired, true);
      assert.equal(res.body.hasProductAccess, false);
      assert.equal(res.body.denialReason, 'Access expired');
    });

    it('expired access is rejected by websocket auth', async () => {
      const result = await connectSocket('http://127.0.0.1:3099', userToken);
      assert.equal(result.connected, false);
      assert.equal(result.error, 'Access expired');
    });

    it('restores access for further tests', async () => {
      const { query } = require('../src/models/db');
      await query(
        `UPDATE users
         SET access_status = 'active',
             access_expires_at = NOW() + INTERVAL '30 days',
             access_source = 'payment',
             access_updated_at = NOW()
         WHERE username = 'regular_user'`
      );

      const login = await startLogin('user@test.com', 'newpass456');
      const otp = await verifyLoginOtp(login.body.challengeToken, login.body.emailDebug.otpCode);
      assert.equal(otp.status, 200);
      assert.equal(otp.body.requiresPreAccess, undefined);
      assert.ok(otp.body.token);

      const complete = await request('POST', '/api/pre-access/complete', {
        token: preAccessToken,
        headers: {
          origin: 'http://localhost:5173',
        },
      });
      assert.equal(complete.status, 200);
      assert.ok(complete.body.token);
      userToken = complete.body.token;

      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 200);
    });
  });

  describe('404 Handler', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request('GET', '/api/nonexistent');
      assert.equal(res.status, 404);
    });
  });
});
