const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: createSocketClient } = require('../frontend/node_modules/socket.io-client');

function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: process.env.TEST_PORT || 3099,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
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

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.emailVerificationRequired, true);
  assert.ok(registerResponse.body.emailDebug?.actionUrl);
  assert.equal(new URL(registerResponse.body.emailDebug.actionUrl).pathname, '/auth/verify-email');

  const verificationToken = getQueryToken(registerResponse.body.emailDebug.actionUrl);
  const verifyResponse = await request('POST', '/api/auth/verify-email/confirm', {
    body: { token: verificationToken },
  });

  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyResponse.body.requiresPreAccess, true);
  assert.equal(verifyResponse.body.redirectPath, '/access');
  assert.equal(verifyResponse.body.user.isEmailVerified, true);
  assert.ok(verifyResponse.body.preAccessToken);
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

    const { pool } = require('../src/models/db');

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
      await verifyEmailFromRegisterResponse(res);

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
      await verifyEmailFromRegisterResponse(res);
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
