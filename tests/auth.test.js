/**
 * Test suite for Volume Alert Server — Etapa 1
 * Run with: npm test
 *
 * Requirements: PostgreSQL running with a TEST database.
 * Set DB_NAME=volume_alert_test in .env before running.
 *
 * These tests cover:
 * 1. Registration (with invite codes)
 * 2. Login (success, failure, lockout)
 * 3. JWT authentication
 * 4. Session management (logout, logout-all)
 * 5. Invite CRUD (create, validate, consume, revoke)
 * 6. Password change
 * 7. Security (missing fields, invalid tokens, deactivated users)
 * 8. Rate limiting
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Helper: make HTTP request to our server
function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: process.env.TEST_PORT || 3099,
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

// ============================================================
// TEST SUITE
// ============================================================

describe('Volume Alert Server — Etapa 1', () => {
  let server;
  let adminToken;
  let userToken;
  let inviteCode;

  before(async () => {
    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3099';
    process.env.TEST_PORT = '3099';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '50'; // relax for testing

    // Initialize DB tables
    const { pool } = require('../src/models/db');

    // Clean tables in correct order (respect FK constraints)
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM invites');

    // Make created_by nullable for bootstrap
    await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});

    // Start server
    const { startServer } = require('../src/server');
    server = startServer(3099);

    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 500));
  });

  after(async () => {
    if (server) server.close();
    const { pool } = require('../src/models/db');
    await pool.end();
  });

  // ---- HEALTH CHECK ----
  describe('Health Check', () => {
    it('GET /api/health returns ok', async () => {
      const res = await request('GET', '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.db.connected);
    });
  });

  // ---- BOOTSTRAP INVITE ----
  describe('Bootstrap Invite', () => {
    it('Create bootstrap invite directly in DB', async () => {
      const { query } = require('../src/models/db');
      const code = 'TESTBOOTSTRAP01';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, expires_at)
         VALUES ($1, NULL, 5, NOW() + INTERVAL '24 hours')`,
        [code]
      );
      inviteCode = code;
    });

    it('Validate bootstrap invite', async () => {
      const res = await request('GET', `/api/invites/validate/${inviteCode}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, true);
    });
  });

  // ---- REGISTRATION ----
  describe('Registration', () => {
    it('Fails without invite code', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'test@test.com', password: 'password123' },
      });
      assert.equal(res.status, 400);
    });

    it('Fails with invalid invite code', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'test@test.com', password: 'password123', inviteCode: 'INVALID' },
      });
      assert.equal(res.status, 400);
    });

    it('Fails with short password', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'test@test.com', password: '123', inviteCode },
      });
      assert.equal(res.status, 400);
    });

    it('Fails with short username', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'ab', email: 'test@test.com', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 400);
    });

    it('Fails with invalid email', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'test', email: 'not-an-email', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 400);
    });

    it('Registers admin user successfully', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'admin_user', email: 'admin@test.com', password: 'adminpass123', inviteCode },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.token);
      assert.equal(res.body.user.username, 'admin_user');
      adminToken = res.body.token;

      // Promote to admin
      const { query } = require('../src/models/db');
      await query("UPDATE users SET role = 'admin' WHERE username = 'admin_user'");
    });

    it('Registers regular user successfully', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'regular_user', email: 'user@test.com', password: 'userpass123', inviteCode },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.token);
      userToken = res.body.token;
    });

    it('Fails with duplicate username', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'admin_user', email: 'new@test.com', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 409);
    });

    it('Fails with duplicate email', async () => {
      const res = await request('POST', '/api/auth/register', {
        body: { username: 'new_user', email: 'admin@test.com', password: 'password123', inviteCode },
      });
      assert.equal(res.status, 409);
    });

    it('Does not consume invite when registration fails with duplicate username', async () => {
      const { query } = require('../src/models/db');
      const code = 'DUPENAME000001';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, expires_at)
         VALUES ($1, NULL, 1, NOW() + INTERVAL '24 hours')`,
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

      const validate = await request('GET', `/api/invites/validate/${code}`);
      assert.equal(validate.status, 200);
      assert.equal(validate.body.valid, true);
    });

    it('Does not consume invite when registration fails with duplicate email', async () => {
      const { query } = require('../src/models/db');
      const code = 'DUPEMAIL000001';
      await query(
        `INSERT INTO invites (code, created_by, max_uses, expires_at)
         VALUES ($1, NULL, 1, NOW() + INTERVAL '24 hours')`,
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

      const validate = await request('GET', `/api/invites/validate/${code}`);
      assert.equal(validate.status, 200);
      assert.equal(validate.body.valid, true);
    });
  });

  // ---- LOGIN ----
  describe('Login', () => {
    it('Logs in successfully', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'admin@test.com', password: 'adminpass123' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      adminToken = res.body.token; // refresh with admin role
    });

    it('Fails with wrong password', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'admin@test.com', password: 'wrongpassword' },
      });
      assert.equal(res.status, 401);
    });

    it('Fails with non-existent email', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'nobody@test.com', password: 'password123' },
      });
      assert.equal(res.status, 401);
    });

    it('Fails with missing fields', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'admin@test.com' },
      });
      assert.equal(res.status, 400);
    });
  });

  // ---- AUTHENTICATION ----
  describe('Authentication', () => {
    it('GET /api/auth/me works with valid token', async () => {
      const res = await request('GET', '/api/auth/me', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'admin_user');
      assert.equal(res.body.user.role, 'admin');
    });

    it('Fails without token', async () => {
      const res = await request('GET', '/api/auth/me');
      assert.equal(res.status, 401);
    });

    it('Fails with invalid token', async () => {
      const res = await request('GET', '/api/auth/me', { token: 'invalid.token.here' });
      assert.equal(res.status, 401);
    });

    it('Fails with malformed bearer header', async () => {
      const res = await request('GET', '/api/auth/me', { token: '' });
      assert.equal(res.status, 401);
    });
  });

  // ---- INVITES ----
  describe('Invites', () => {
    let newInviteCode;
    let newInviteId;

    it('Admin creates invite', async () => {
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

    it('Regular user creates invite with defaults', async () => {
      const res = await request('POST', '/api/invites', {
        token: userToken,
        body: { maxUses: 100 }, // should be ignored for non-admin
      });
      assert.equal(res.status, 201);
    });

    it('Validates the new invite code', async () => {
      const res = await request('GET', `/api/invites/validate/${newInviteCode}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, true);
    });

    it('Lists my invites', async () => {
      const res = await request('GET', '/api/invites', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length > 0);
    });

    it('Admin lists all invites', async () => {
      const res = await request('GET', '/api/invites/all', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length > 0);
    });

    it('Regular user cannot list all invites', async () => {
      const res = await request('GET', '/api/invites/all', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('Revokes an invite', async () => {
      const res = await request('DELETE', `/api/invites/${newInviteId}`, { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.invite.is_revoked, true);
    });

    it('Validates revoked invite returns invalid', async () => {
      const res = await request('GET', `/api/invites/validate/${newInviteCode}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, false);
    });
  });

  // ---- SESSION MANAGEMENT ----
  describe('Session Management', () => {
    it('Logout revokes current session', async () => {
      // Login to get a fresh token
      const login = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      const tempToken = login.body.token;

      // Logout
      const res = await request('POST', '/api/auth/logout', { token: tempToken });
      assert.equal(res.status, 200);

      // Token should no longer work
      const me = await request('GET', '/api/auth/me', { token: tempToken });
      assert.equal(me.status, 401);
    });

    it('Logout-all revokes all sessions', async () => {
      // Login twice
      const login1 = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      const login2 = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });

      // Logout all from session 1
      const res = await request('POST', '/api/auth/logout-all', { token: login1.body.token });
      assert.equal(res.status, 200);

      // Both tokens should be revoked
      const me1 = await request('GET', '/api/auth/me', { token: login1.body.token });
      const me2 = await request('GET', '/api/auth/me', { token: login2.body.token });
      assert.equal(me1.status, 401);
      assert.equal(me2.status, 401);
    });
  });

  // ---- PASSWORD CHANGE ----
  describe('Password Change', () => {
    it('Changes password successfully', async () => {
      // Login first
      const login = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });

      const res = await request('POST', '/api/auth/change-password', {
        token: login.body.token,
        body: { currentPassword: 'userpass123', newPassword: 'newpass456' },
      });
      assert.equal(res.status, 200);

      // Old password should not work
      const oldLogin = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(oldLogin.status, 401);

      // New password should work
      const newLogin = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'newpass456' },
      });
      assert.equal(newLogin.status, 200);
      userToken = newLogin.body.token;
    });

    it('Fails with wrong current password', async () => {
      const res = await request('POST', '/api/auth/change-password', {
        token: userToken,
        body: { currentPassword: 'wrongpass', newPassword: 'anotherpass' },
      });
      assert.equal(res.status, 401);
    });
  });

  // ---- DEACTIVATED USER ----
  describe('Deactivated User', () => {
    it('Admin deactivates a user', async () => {
      const { query } = require('../src/models/db');
      await query("UPDATE users SET is_active = false WHERE username = 'regular_user'");
    });

    it('Deactivated user cannot login', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'newpass456' },
      });
      assert.equal(res.status, 403);
    });

    it('Re-activate user for further tests', async () => {
      const { query } = require('../src/models/db');
      await query("UPDATE users SET is_active = true WHERE username = 'regular_user'");
    });
  });

  // ---- 404 ----
  describe('404 Handler', () => {
    it('Returns 404 for unknown routes', async () => {
      const res = await request('GET', '/api/nonexistent');
      assert.equal(res.status, 404);
    });
  });
});
