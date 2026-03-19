/**
 * Test suite for Admin Panel — Etapa 2
 * Run with: npm test
 *
 * Covers:
 * 1. Admin stats endpoint
 * 2. User listing (admin vs regular user)
 * 3. Online users
 * 4. User modification (activate/deactivate/role change)
 * 5. Force logout
 * 6. Admin invite management
 * 7. Login logs
 * 8. Security: regular user cannot access admin endpoints
 * 9. Security: admin cannot modify self or other admins
 */

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
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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

describe('Admin Panel — Etapa 2', () => {
  let server;
  let adminToken;
  let userToken;
  let userId;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3098';
    process.env.TEST_PORT = '3098';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100';

    const { pool } = require('../src/models/db');

    // Clean tables
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM invites');
    await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});

    // Create bootstrap invite
    await pool.query(
      `INSERT INTO invites (code, created_by, max_uses, expires_at)
       VALUES ('ADMINTEST0001', NULL, 10, NOW() + INTERVAL '24 hours')`
    );

    // Start server
    const { startServer } = require('../src/server');
    server = startServer(3098);
    await new Promise(r => setTimeout(r, 500));

    // Register admin
    const adminReg = await request('POST', '/api/auth/register', {
      body: { username: 'testadmin', email: 'admin@test.com', password: 'adminpass123', inviteCode: 'ADMINTEST0001' },
    });
    await pool.query("UPDATE users SET role = 'admin' WHERE username = 'testadmin'");

    // Login admin (to get token with admin role)
    const adminLogin = await request('POST', '/api/auth/login', {
      body: { email: 'admin@test.com', password: 'adminpass123' },
    });
    adminToken = adminLogin.body.token;

    // Register regular user
    const userReg = await request('POST', '/api/auth/register', {
      body: { username: 'testuser', email: 'user@test.com', password: 'userpass123', inviteCode: 'ADMINTEST0001' },
    });
    userToken = userReg.body.token;
    userId = userReg.body.user.id;
  });

  after(async () => {
    if (server) server.close();
    const { pool } = require('../src/models/db');
    await pool.end();
  });

  // ---- SECURITY: Regular user blocked from all admin endpoints ----
  describe('Security — Regular user cannot access admin', () => {
    it('GET /api/admin/stats → 403', async () => {
      const res = await request('GET', '/api/admin/stats', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/users → 403', async () => {
      const res = await request('GET', '/api/admin/users', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/users/online → 403', async () => {
      const res = await request('GET', '/api/admin/users/online', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('PATCH /api/admin/users/:id → 403', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: userToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/logs → 403', async () => {
      const res = await request('GET', '/api/admin/logs', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/invites → 403', async () => {
      const res = await request('GET', '/api/admin/invites', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('No token → 401', async () => {
      const res = await request('GET', '/api/admin/stats');
      assert.equal(res.status, 401);
    });
  });

  // ---- STATS ----
  describe('Admin Stats', () => {
    it('Returns dashboard stats', async () => {
      const res = await request('GET', '/api/admin/stats', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.users);
      assert.ok(res.body.sessions);
      assert.ok(res.body.invites);
      assert.ok(res.body.loginAttempts24h);
      assert.ok(res.body.users.total >= 2); // admin + user
      assert.ok(res.body.sessions.active >= 1);
    });
  });

  // ---- USERS ----
  describe('Admin Users', () => {
    it('Lists all users with invite info', async () => {
      const res = await request('GET', '/api/admin/users', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.users.length >= 2);
      assert.ok(res.body.total >= 2);
      // Check fields
      const user = res.body.users.find(u => u.username === 'testuser');
      assert.ok(user);
      assert.ok(user.email);
      assert.ok(user.created_at);
    });

    it('Lists online users', async () => {
      const res = await request('GET', '/api/admin/users/online', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.online.length >= 1);
      assert.ok(res.body.count >= 1);
    });
  });

  // ---- USER MODIFICATION ----
  describe('Admin User Modification', () => {
    it('Deactivates a user and revokes sessions', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, false);
      assert.ok(res.body.message.includes('deactivated'));
    });

    it('Deactivated user cannot login', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(res.status, 403);
    });

    it('Reactivates a user', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, true);
    });

    it('Reactivated user can login again', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(res.status, 200);
      userToken = res.body.token;
    });

    it('Cannot modify self', async () => {
      // Get admin ID
      const me = await request('GET', '/api/auth/me', { token: adminToken });
      const res = await request('PATCH', `/api/admin/users/${me.body.user.id}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('own account'));
    });

    it('Rejects invalid user ID', async () => {
      const res = await request('PATCH', '/api/admin/users/abc', {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 400);
    });

    it('Rejects non-existent user', async () => {
      const res = await request('PATCH', '/api/admin/users/99999', {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 404);
    });

    it('Rejects empty update', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: {},
      });
      assert.equal(res.status, 400);
    });

    it('Can promote user to admin', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { role: 'admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, 'admin');
    });

    it('Cannot modify another admin', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes('another admin'));
    });

    it('Revert user back to regular role via SQL for further tests', async () => {
      const { query: dbQuery } = require('../src/models/db');
      await dbQuery("UPDATE users SET role = 'user' WHERE id = $1", [userId]);
    });
  });

  // ---- FORCE LOGOUT ----
  describe('Admin Force Logout', () => {
    it('Force-logouts a user', async () => {
      const res = await request('DELETE', `/api/admin/users/${userId}/sessions`, {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('Revoked'));
    });

    it('User token no longer works after force logout', async () => {
      const res = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(res.status, 401);
    });

    it('User can login again after force logout', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(res.status, 200);
      userToken = res.body.token;
    });
  });

  // ---- ADMIN INVITES ----
  describe('Admin Invites', () => {
    let inviteId;

    it('Creates invite with custom params', async () => {
      const res = await request('POST', '/api/admin/invites', {
        token: adminToken,
        body: { maxUses: 5, expiryHours: 48 },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.invite.max_uses, 5);
      inviteId = res.body.invite.id;
    });

    it('Lists all invites', async () => {
      const res = await request('GET', '/api/admin/invites', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length >= 1);
    });

    it('Revokes an invite', async () => {
      const res = await request('DELETE', `/api/admin/invites/${inviteId}`, { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.invite.is_revoked, true);
    });

    it('Returns 404 for non-existent invite', async () => {
      const res = await request('DELETE', '/api/admin/invites/99999', { token: adminToken });
      assert.equal(res.status, 404);
    });
  });

  // ---- LOGS ----
  describe('Admin Logs', () => {
    it('Returns login attempts', async () => {
      const res = await request('GET', '/api/admin/logs', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.logs.length >= 1);
      // Check fields
      assert.ok(res.body.logs[0].email);
      assert.ok(res.body.logs[0].created_at);
    });

    it('Filters by success=false', async () => {
      const res = await request('GET', '/api/admin/logs?success=false', { token: adminToken });
      assert.equal(res.status, 200);
      for (const log of res.body.logs) {
        assert.equal(log.success, false);
      }
    });

    it('Respects limit parameter', async () => {
      const res = await request('GET', '/api/admin/logs?limit=2', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.logs.length <= 2);
    });
  });
});
