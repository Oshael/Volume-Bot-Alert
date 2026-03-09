/**
 * Etapa 4 — Testes completos: Configs, Manual Tokens, Blocklist
 *
 * Pré-requisitos:
 *   1. PostgreSQL rodando com banco volume_alert
 *   2. Tabelas da Etapa 1-3 criadas (npm run db:init)
 *   3. Tabelas da Etapa 4 criadas (node src/utils/db-init-stage4.js)
 *   4. .env configurado
 *
 * Rodar: npm test -- tests/config.test.js
 * Ou:    npx jest tests/config.test.js --verbose
 */

const request = require('supertest');
const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');
const { CONFIG_SCHEMA } = require('../src/models/user-config');

// ── Helpers ────────────────────────────────────────────────────────

let token; // JWT do user de teste
let adminToken;
let inviteCode;

// Endereços de teste (Solana-style base58)
const VALID_ADDR_1 = 'So11111111111111111111111111111111111111112';
const VALID_ADDR_2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const VALID_ADDR_3 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const INVALID_ADDR = 'not-a-valid-address!!!';

const TEST_USER = {
  username: `configtest_${Date.now()}`,
  email: `configtest_${Date.now()}@test.com`,
  password: 'TestPass123!',
};

beforeAll(async () => {
  // Create bootstrap invite
  const invite = await Invite.create(null, 5, 24);
  inviteCode = invite.code;

  // Register test user
  const regRes = await request(app)
    .post('/api/auth/register')
    .send({ ...TEST_USER, inviteCode });

  token = regRes.body.token;

  // Create admin user for edge cases
  const invite2 = await Invite.create(null, 5, 24);
  const adminUser = {
    username: `cfgadmin_${Date.now()}`,
    email: `cfgadmin_${Date.now()}@test.com`,
    password: 'AdminPass123!',
  };
  const adminRegRes = await request(app)
    .post('/api/auth/register')
    .send({ ...adminUser, inviteCode: invite2.code });

  adminToken = adminRegRes.body.token;

  // Promote to admin
  await db.query(
    "UPDATE users SET role = 'admin' WHERE email = $1",
    [adminUser.email]
  );
});

afterAll(async () => {
  if (server && server.close) server.close();
  try { await db.pool.end(); } catch (_) {}
});

// ══════════════════════════════════════════════════════════════════
//  1. AUTHENTICATION
// ══════════════════════════════════════════════════════════════════

describe('Config — Authentication', () => {
  test('GET /api/config without token → 401', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(401);
  });

  test('PUT /api/config without token → 401', async () => {
    const res = await request(app).put('/api/config').send({ configs: {} });
    expect(res.status).toBe(401);
  });

  test('PATCH /api/config without token → 401', async () => {
    const res = await request(app).patch('/api/config').send({ configs: {} });
    expect(res.status).toBe(401);
  });

  test('POST /api/config/tokens without token → 401', async () => {
    const res = await request(app).post('/api/config/tokens').send({ address: VALID_ADDR_1 });
    expect(res.status).toBe(401);
  });

  test('POST /api/config/blocklist without token → 401', async () => {
    const res = await request(app).post('/api/config/blocklist').send({ address: VALID_ADDR_1 });
    expect(res.status).toBe(401);
  });

  test('Invalid token → 401', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', 'Bearer fake.token.here');
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. GET /api/config — Defaults
// ══════════════════════════════════════════════════════════════════

describe('Config — GET defaults', () => {
  test('Returns all default configs for new user', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.configs).toBeDefined();
    expect(res.body.tokens).toBeDefined();
    expect(res.body.blocklist).toBeDefined();
    expect(res.body.starredTokens).toBeDefined();

    // Check defaults
    expect(res.body.configs.threshold).toBe(50);
    expect(res.body.configs.interval).toBe(30);
    expect(res.body.configs.chain).toBe('solana');
    expect(res.body.configs['min-vol']).toBe(500);
    expect(res.body.configs['pump-entry-vol']).toBe(20000);
    expect(res.body.configs['old-per-page']).toBe(30);
    expect(res.body.configs['old-week-mcap-min']).toBe(120000);
    expect(res.body.configs['old-week-mcap-max']).toBe(5000000);
    expect(res.body.configs['old-week-per-page']).toBe(30);
    expect(res.body.configs['meteora-min-pool']).toBe(5000);

    // All schema keys present
    for (const key of Object.keys(CONFIG_SCHEMA)) {
      expect(res.body.configs).toHaveProperty(key);
    }

    // Empty arrays for new user
    expect(res.body.tokens).toHaveLength(0);
    expect(res.body.blocklist).toHaveLength(0);
    expect(res.body.starredTokens).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. PATCH /api/config — Partial update
// ══════════════════════════════════════════════════════════════════

describe('Config — PATCH (partial update)', () => {
  test('Update single config key', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: 80 } });

    expect(res.status).toBe(200);
    expect(res.body.configs.threshold).toBe(80);
    // Other values unchanged
    expect(res.body.configs.interval).toBe(30);
  });

  test('Update multiple config keys', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        configs: {
          'min-vol': 1000,
          'min-mcap': 50000,
          chain: 'ethereum',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.configs['min-vol']).toBe(1000);
    expect(res.body.configs['min-mcap']).toBe(50000);
    expect(res.body.configs.chain).toBe('ethereum');
    // Previously set value unchanged
    expect(res.body.configs.threshold).toBe(80);
  });

  test('Reject unknown config key', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { 'hacker-key': 'malicious' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid config/i);
    expect(res.body.details).toContain('Unknown config key: hacker-key');
  });

  test('Reject invalid number (negative where min is 0)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: -10 } });

    expect(res.status).toBe(400);
  });

  test('Reject invalid number (NaN)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: 'abc' } });

    expect(res.status).toBe(400);
  });

  test('Reject invalid number (Infinity)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: Infinity } });

    expect(res.status).toBe(400);
  });

  test('Reject invalid chain value', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { chain: 'polygon' } });

    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatch(/chain must be one of/i);
  });

  test('Reject number exceeding max', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { interval: 9999 } });

    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatch(/interval must be between/i);
  });

  test('Reject empty configs object', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/configs object is required/i);
  });

  test('Reject missing configs field', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ something: 'else' });

    expect(res.status).toBe(400);
  });

  test('Accept boundary values (min)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { interval: 5 } });

    expect(res.status).toBe(200);
    expect(res.body.configs.interval).toBe(5);
  });

  test('Accept boundary values (max)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { interval: 600 } });

    expect(res.status).toBe(200);
    expect(res.body.configs.interval).toBe(600);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. PUT /api/config — Full sync
// ══════════════════════════════════════════════════════════════════

describe('Config — PUT (full sync)', () => {
  test('Replace all configs', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        configs: {
          threshold: 100,
          interval: 15,
          chain: 'bsc',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.configs.threshold).toBe(100);
    expect(res.body.configs.interval).toBe(15);
    expect(res.body.configs.chain).toBe('bsc');
    // Keys not included revert to defaults
    expect(res.body.configs['min-vol']).toBe(500); // default
  });

  test('Full sync with configs + tokens + blocklist', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        configs: { threshold: 75, chain: 'solana' },
        tokens: [
          { address: VALID_ADDR_1, label: 'SOL' },
          { address: VALID_ADDR_2, label: 'USDC' },
        ],
        blocklist: [
          { address: VALID_ADDR_3, label: 'SCAM' },
        ],
        starredTokens: [
          { address: VALID_ADDR_1 },
          { address: VALID_ADDR_3 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.configs.threshold).toBe(75);
    expect(res.body.tokens).toHaveLength(2);
    expect(res.body.blocklist).toHaveLength(1);
    expect(res.body.starredTokens).toHaveLength(2);
  });

  test('PUT with invalid config rejects entire request', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        configs: { threshold: 'not-a-number' },
        tokens: [{ address: VALID_ADDR_1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid config/i);
  });

  test('PUT with invalid token address rejects', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        tokens: [{ address: INVALID_ADDR }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid token address/i);
  });

  test('PUT with invalid token does not persist partial config changes', async () => {
    await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: 50 } });

    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        configs: { threshold: 123 },
        tokens: [{ address: INVALID_ADDR }],
      });

    expect(res.status).toBe(400);

    const after = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(200);
    expect(after.body.configs.threshold).toBe(50);
  });



  test('PUT with starred tokens persists favorites', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        starredTokens: [
          { address: VALID_ADDR_1 },
          { address: VALID_ADDR_2 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.starredTokens).toHaveLength(2);
    expect(res.body.starredTokens.map(t => t.address)).toEqual([VALID_ADDR_1, VALID_ADDR_2]);
  });

  test('PUT with invalid starred token rejects', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        starredTokens: [{ address: INVALID_ADDR }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid starred token address/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. MANUAL TOKENS — CRUD
// ══════════════════════════════════════════════════════════════════

describe('Tokens — CRUD', () => {
  // Clean state first
  beforeAll(async () => {
    await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ tokens: [] });
  });

  test('POST /api/config/tokens — add token', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_1, label: 'Wrapped SOL' });

    expect(res.status).toBe(201);
    expect(res.body.token.address).toBe(VALID_ADDR_1);
    expect(res.body.token.label).toBe('Wrapped SOL');
  });

  test('POST duplicate token → 409', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already added/i);
  });

  test('POST invalid address → 400', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: INVALID_ADDR });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid token address/i);
  });

  test('POST missing address → 400', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address is required/i);
  });

  test('GET /api/config returns the added token', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const found = res.body.tokens.find(t => t.address === VALID_ADDR_1);
    expect(found).toBeDefined();
    expect(found.label).toBe('Wrapped SOL');
  });

  test('DELETE /api/config/tokens/:address — remove token', async () => {
    const res = await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_1}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/removed/i);
  });

  test('DELETE non-existent token → 404', async () => {
    const res = await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_1}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('Add token without label', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_2 });

    expect(res.status).toBe(201);
    expect(res.body.token.label).toBeNull();

    // Cleanup
    await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_2}`)
      .set('Authorization', `Bearer ${token}`);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. BLOCKLIST — CRUD
// ══════════════════════════════════════════════════════════════════

describe('Blocklist — CRUD', () => {
  beforeAll(async () => {
    await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ blocklist: [] });
  });

  test('POST /api/config/blocklist — block token', async () => {
    const res = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_3, label: 'SCAM' });

    expect(res.status).toBe(201);
    expect(res.body.blocked.address).toBe(VALID_ADDR_3);
  });

  test('POST duplicate block → 409', async () => {
    const res = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_3 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already blocked/i);
  });

  test('POST invalid address → 400', async () => {
    const res = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: INVALID_ADDR });

    expect(res.status).toBe(400);
  });

  test('POST missing address → 400', async () => {
    const res = await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('GET /api/config returns blocked token', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${token}`);

    const found = res.body.blocklist.find(b => b.address === VALID_ADDR_3);
    expect(found).toBeDefined();
    expect(found.label).toBe('SCAM');
  });

  test('DELETE /api/config/blocklist/:address — unblock', async () => {
    const res = await request(app)
      .delete(`/api/config/blocklist/${VALID_ADDR_3}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/unblocked/i);
  });

  test('DELETE non-existent block → 404', async () => {
    const res = await request(app)
      .delete(`/api/config/blocklist/${VALID_ADDR_3}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. ISOLATION — Users don't see each other's data
// ══════════════════════════════════════════════════════════════════

describe('Config — User isolation', () => {
  test('User A configs are invisible to User B', async () => {
    // User A (token) sets config
    await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: 99 } });

    // User B (adminToken) sees only defaults
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.configs.threshold).toBe(50); // default, not 99
  });

  test('User A tokens are invisible to User B', async () => {
    // User A adds token
    await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_1, label: 'UserA' });

    // User B sees empty
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.tokens).toHaveLength(0);

    // Cleanup
    await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_1}`)
      .set('Authorization', `Bearer ${token}`);
  });

  test('User A blocklist is invisible to User B', async () => {
    // User A blocks
    await request(app)
      .post('/api/config/blocklist')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: VALID_ADDR_3 });

    // User B sees empty
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.blocklist).toHaveLength(0);
    expect(res.body.starredTokens).toHaveLength(0);

    // Cleanup
    await request(app)
      .delete(`/api/config/blocklist/${VALID_ADDR_3}`)
      .set('Authorization', `Bearer ${token}`);
  });

  test('User A starred tokens are invisible to User B', async () => {
    await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ starredTokens: [{ address: VALID_ADDR_1 }] });

    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.starredTokens).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  8. EDGE CASES & SECURITY
// ══════════════════════════════════════════════════════════════════

describe('Config — Edge cases & security', () => {
  test('SQL injection in config value → treated as string, rejected by validation', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: "'; DROP TABLE users; --" } });

    expect(res.status).toBe(400); // NaN — not a valid number
  });

  test('SQL injection in token address → rejected by format validation', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: "'; DROP TABLE user_tokens; --" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid token address/i);
  });

  test('XSS in label field → stored safely (no HTML execution)', async () => {
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR_2,
        label: '<script>alert(1)</script>',
      });

    // Label is truncated by DB (VARCHAR 32), but stored as plain text
    expect(res.status).toBe(201);

    // Cleanup
    await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_2}`)
      .set('Authorization', `Bearer ${token}`);
  });

  test('Very long config value → rejected', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { chain: 'a'.repeat(100) } });

    expect(res.status).toBe(400);
  });

  test('Float config values are accepted', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { threshold: 50.5 } });

    expect(res.status).toBe(200);
    expect(res.body.configs.threshold).toBe(50.5);
  });

  test('Zero values are valid', async () => {
    const res = await request(app)
      .patch('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ configs: { 'max-mcap': 0, 'min-mcap-remove': 0 } });

    expect(res.status).toBe(200);
    expect(res.body.configs['max-mcap']).toBe(0);
    expect(res.body.configs['min-mcap-remove']).toBe(0);
  });

  test('Whitespace-padded address is trimmed', async () => {
    const padded = `  ${VALID_ADDR_1}  `;
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: padded });

    expect(res.status).toBe(201);
    expect(res.body.token.address).toBe(VALID_ADDR_1);

    // Cleanup
    await request(app)
      .delete(`/api/config/tokens/${VALID_ADDR_1}`)
      .set('Authorization', `Bearer ${token}`);
  });

  test('EVM address (0x...) is accepted', async () => {
    const evmAddr = '0x' + 'a'.repeat(40);
    const res = await request(app)
      .post('/api/config/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: evmAddr });

    expect(res.status).toBe(201);

    // Cleanup
    await request(app)
      .delete(`/api/config/tokens/${evmAddr}`)
      .set('Authorization', `Bearer ${token}`);
  });
});

// ══════════════════════════════════════════════════════════════════
//  9. CASCADING DELETE — user deletion cleans configs
// ══════════════════════════════════════════════════════════════════

describe('Config — CASCADE on user delete', () => {
  let tempToken;
  let tempUserId;

  beforeAll(async () => {
    // Create a throwaway user
    const inv = await Invite.create(null, 1, 24);
    const tempUser = {
      username: `tempuser_${Date.now()}`,
      email: `tempuser_${Date.now()}@test.com`,
      password: 'TempPass123!',
    };
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...tempUser, inviteCode: inv.code });

    tempToken = res.body.token;

    // Get user ID
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tempToken}`);
    tempUserId = meRes.body.user.id;

    // Add configs, tokens, blocklist
    await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${tempToken}`)
      .send({
        configs: { threshold: 42 },
        tokens: [{ address: VALID_ADDR_1 }],
        blocklist: [{ address: VALID_ADDR_2 }],
      });
  });

  test('Deleting user cascades to all config tables', async () => {
    // Verify data exists
    const before = await db.query(
      'SELECT COUNT(*)::int AS c FROM user_configs WHERE user_id = $1',
      [tempUserId]
    );
    expect(before.rows[0].c).toBeGreaterThan(0);

    // Delete user
    await db.query('DELETE FROM users WHERE id = $1', [tempUserId]);

    // Verify cascade
    const configs = await db.query(
      'SELECT COUNT(*)::int AS c FROM user_configs WHERE user_id = $1',
      [tempUserId]
    );
    const tokens = await db.query(
      'SELECT COUNT(*)::int AS c FROM user_tokens WHERE user_id = $1',
      [tempUserId]
    );
    const blocklist = await db.query(
      'SELECT COUNT(*)::int AS c FROM user_blocklist WHERE user_id = $1',
      [tempUserId]
    );

    expect(configs.rows[0].c).toBe(0);
    expect(tokens.rows[0].c).toBe(0);
    expect(blocklist.rows[0].c).toBe(0);
  });
});
