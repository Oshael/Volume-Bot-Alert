const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: process.env.TEST_PORT || 3098,
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
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
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

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.emailVerificationRequired, true);
  assert.ok(registerResponse.body.emailDebug?.actionUrl);

  const verificationToken = getQueryToken(registerResponse.body.emailDebug.actionUrl);
  const verifyResponse = await request('POST', '/api/auth/verify-email/confirm', {
    body: { token: verificationToken },
  });

  assert.equal(verifyResponse.status, 200);
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
  return verifyResponse.body.token;
}

describe('Admin panel auth and management', () => {
  let server;
  let adminToken;
  let userToken;
  let userId;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3098';
    process.env.TEST_PORT = '3098';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100';
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_PROVIDER = 'local';
    process.env.EMAIL_FROM = 'tests@trendscope.local';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';

    const { pool } = require('../src/models/db');

    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM invites');
    await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});

    await pool.query(
      `INSERT INTO invites (code, created_by, max_uses, expires_at)
       VALUES ('ADMINTEST0001', NULL, 10, NOW() + INTERVAL '24 hours')`
    );

    const { startServer } = require('../src/server');
    server = startServer(3098);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const adminReg = await request('POST', '/api/auth/register', {
      body: { username: 'testadmin', email: 'admin@test.com', password: 'adminpass123', inviteCode: 'ADMINTEST0001' },
    });
    await verifyEmailFromRegisterResponse(adminReg);
    await pool.query("UPDATE users SET role = 'admin' WHERE username = 'testadmin'");
    adminToken = await completeLogin('admin@test.com', 'adminpass123');

    const userReg = await request('POST', '/api/auth/register', {
      body: { username: 'testuser', email: 'user@test.com', password: 'userpass123', inviteCode: 'ADMINTEST0001' },
    });
    await verifyEmailFromRegisterResponse(userReg);
    userId = userReg.body.user.id;
    userToken = await completeLogin('user@test.com', 'userpass123');
  });

  after(async () => {
    const socketHub = require('../src/services/socket-hub');
    socketHub.stop();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const { pool } = require('../src/models/db');
    await pool.end();
  });

  describe('Security — regular user cannot access admin', () => {
    it('GET /api/admin/stats -> 403', async () => {
      const res = await request('GET', '/api/admin/stats', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/users -> 403', async () => {
      const res = await request('GET', '/api/admin/users', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/users/online -> 403', async () => {
      const res = await request('GET', '/api/admin/users/online', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('PATCH /api/admin/users/:id -> 403', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: userToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/logs -> 403', async () => {
      const res = await request('GET', '/api/admin/logs', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/invites -> 403', async () => {
      const res = await request('GET', '/api/admin/invites', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('no token -> 401', async () => {
      const res = await request('GET', '/api/admin/stats');
      assert.equal(res.status, 401);
    });
  });

  describe('Admin Stats', () => {
    it('returns dashboard stats', async () => {
      const res = await request('GET', '/api/admin/stats', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.users);
      assert.ok(res.body.sessions);
      assert.ok(res.body.invites);
      assert.ok(res.body.loginAttempts24h);
      assert.ok(res.body.users.total >= 2);
      assert.ok(res.body.sessions.active >= 1);
    });
  });

  describe('Admin Users', () => {
    it('lists all users with invite info', async () => {
      const res = await request('GET', '/api/admin/users', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.users.length >= 2);
      assert.ok(res.body.total >= 2);
      const user = res.body.users.find((entry) => entry.username === 'testuser');
      assert.ok(user);
      assert.ok(user.email);
      assert.ok(user.created_at);
    });

    it('lists online users', async () => {
      const res = await request('GET', '/api/admin/users/online', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.online.length >= 1);
      assert.ok(res.body.count >= 1);
    });
  });

  describe('Admin User Modification', () => {
    it('deactivates a user and revokes sessions', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, false);
      assert.ok(res.body.message.includes('deactivated'));

      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 401);
    });

    it('deactivated user cannot login', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(res.status, 403);
    });

    it('reactivates a user', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, true);
    });

    it('reactivated user can login again', async () => {
      userToken = await completeLogin('user@test.com', 'userpass123');
      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 200);
    });

    it('cannot modify self', async () => {
      const me = await request('GET', '/api/auth/me', { token: adminToken });
      const res = await request('PATCH', `/api/admin/users/${me.body.user.id}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('own account'));
    });

    it('rejects invalid user ID', async () => {
      const res = await request('PATCH', '/api/admin/users/abc', {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 400);
    });

    it('rejects non-existent user', async () => {
      const res = await request('PATCH', '/api/admin/users/99999', {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 404);
    });

    it('rejects empty update', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: {},
      });
      assert.equal(res.status, 400);
    });

    it('can promote user to admin', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { role: 'admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, 'admin');
    });

    it('cannot modify another admin', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes('another admin'));
    });

    it('reverts user back to regular role via SQL for further tests', async () => {
      const { query: dbQuery } = require('../src/models/db');
      await dbQuery("UPDATE users SET role = 'user' WHERE id = $1", [userId]);
    });
  });

  describe('Admin Force Logout', () => {
    it('force-logouts a user', async () => {
      const res = await request('DELETE', `/api/admin/users/${userId}/sessions`, {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('Revoked'));
    });

    it('user token no longer works after force logout', async () => {
      const res = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(res.status, 401);
    });

    it('user can login again after force logout', async () => {
      userToken = await completeLogin('user@test.com', 'userpass123');
      const res = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(res.status, 200);
    });
  });

  describe('Admin Invites', () => {
    let inviteId;

    it('creates invite with custom params', async () => {
      const res = await request('POST', '/api/admin/invites', {
        token: adminToken,
        body: { maxUses: 5, expiryHours: 48 },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.invite.max_uses, 5);
      inviteId = res.body.invite.id;
    });

    it('lists all invites', async () => {
      const res = await request('GET', '/api/admin/invites', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length >= 1);
    });

    it('revokes an invite', async () => {
      const res = await request('DELETE', `/api/admin/invites/${inviteId}`, { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.invite.is_revoked, true);
    });

    it('returns 404 for non-existent invite', async () => {
      const res = await request('DELETE', '/api/admin/invites/99999', { token: adminToken });
      assert.equal(res.status, 404);
    });

    it('rejects invalid custom invite params', async () => {
      const res = await request('POST', '/api/admin/invites', {
        token: adminToken,
        body: { maxUses: 'abc' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Admin Logs', () => {
    it('returns login attempts', async () => {
      const res = await request('GET', '/api/admin/logs', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.logs.length >= 1);
      assert.ok(res.body.logs[0].email);
      assert.ok(res.body.logs[0].created_at);
    });

    it('filters by success=false', async () => {
      const res = await request('GET', '/api/admin/logs?success=false', { token: adminToken });
      assert.equal(res.status, 200);
      for (const log of res.body.logs) {
        assert.equal(log.success, false);
      }
    });

    it('respects limit parameter', async () => {
      const res = await request('GET', '/api/admin/logs?limit=2', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.logs.length <= 2);
    });

    it('rejects malformed success filter', async () => {
      const res = await request('GET', '/api/admin/logs?success=maybe', { token: adminToken });
      assert.equal(res.status, 400);
    });

    it('rejects malformed limit filter', async () => {
      const res = await request('GET', '/api/admin/logs?limit=abc', { token: adminToken });
      assert.equal(res.status, 400);
    });
  });
});
