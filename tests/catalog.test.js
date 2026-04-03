process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const dexscreener = require('../src/services/dexscreener');
const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');

const TEST_USER = {
  username: `catalogtest_${Date.now()}`,
  email: `catalogtest_${Date.now()}@test.com`,
  password: 'TestPass123!',
};

const VALID_ADDR = 'So11111111111111111111111111111111111111112';

const originalGetTokenPairs = dexscreener.getTokenPairs;
const originalGetBestPair = dexscreener.getBestPair;

function getQueryToken(actionUrl) {
  assert.ok(actionUrl, 'Expected actionUrl in email debug payload');
  const parsed = new URL(actionUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token, 'Expected token query param in actionUrl');
  return token;
}

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  const verificationToken = getQueryToken(registerResponse.body.emailDebug?.actionUrl);
  const verifyRes = await request(app)
    .post('/api/auth/verify-email/confirm')
    .send({ token: verificationToken });

  assert.equal(verifyRes.status, 200);
}

async function completeLogin(email, password) {
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.otpRequired, true);
  assert.ok(loginRes.body.challengeToken);
  assert.ok(loginRes.body.emailDebug?.otpCode);

  const verifyRes = await request(app)
    .post('/api/auth/login-otp/verify')
    .send({
      challengeToken: loginRes.body.challengeToken,
      code: loginRes.body.emailDebug.otpCode,
    });

  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.body.token);
  return verifyRes.body.token;
}

function buildPair(overrides = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'pair_test_123',
    url: 'https://dexscreener.com/solana/testpair',
    marketCap: 123456,
    priceUsd: '1.23',
    pairCreatedAt: Date.now() - (2 * 24 * 60 * 60 * 1000),
    volume: { h24: 25000 },
    priceChange: { h1: 120, h6: 160 },
    baseToken: { symbol: 'WSOL', name: 'Wrapped SOL' },
    info: {
      imageUrl: 'https://example.com/token.png',
      socials: [{ type: 'twitter', url: 'https://x.com/wsol' }],
    },
    ...overrides,
  };
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

describe('Catalog routes', () => {
  let token;
  let mockPair;
  let mockDataAvailable;

  before(async () => {
    await ensureAccessSchema();
    const invite = await Invite.create(null, { maxUses: 2, expiryHours: 24, grantAccessDays: 30 });
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ ...TEST_USER, inviteCode: invite.code });

    await verifyEmailFromRegisterResponse(regRes);
    token = await completeLogin(TEST_USER.email, TEST_USER.password);

    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    dexscreener.getTokenPairs = async () => (mockDataAvailable ? { pairs: [mockPair] } : null);
    dexscreener.getBestPair = () => (mockDataAvailable ? mockPair : null);
  });

  beforeEach(() => {
    mockPair = buildPair();
    mockDataAvailable = true;
  });

  after(async () => {
    dexscreener.getTokenPairs = originalGetTokenPairs;
    dexscreener.getBestPair = originalGetBestPair;
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    if (server && server.close) server.close();
    await db.pool.end().catch(() => {});
  });

  it('rejects promote without auth', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .send({ address: VALID_ADDR, source: 'monitored-token' });

    assert.equal(res.status, 401);
  });

  it('upserts monitored token into token_catalog when Dex data is available', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'monitored-token',
        chain: 'solana',
        symbol: 'FAKE',
        name: 'Spoofed Name',
        mcap: 999,
        pairUrl: 'https://attacker.example/token',
        imageUrl: 'https://attacker.example/token.png',
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.token.address, VALID_ADDR);
    assert.equal(res.body.token.source, 'monitored-token');

    const { rows } = await db.query(
      'SELECT address, source, symbol, name, last_mcap, last_pair_url, last_image_url, last_twitter_url FROM token_catalog WHERE address = $1',
      [VALID_ADDR]
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, VALID_ADDR);
    assert.equal(rows[0].source, 'monitored-token');
    assert.equal(rows[0].symbol, 'WSOL');
    assert.equal(rows[0].name, 'Wrapped SOL');
    assert.equal(Number(rows[0].last_mcap), 123456);
    assert.equal(rows[0].last_pair_url, 'https://dexscreener.com/solana/testpair');
    assert.equal(rows[0].last_image_url, 'https://example.com/token.png');
    assert.equal(rows[0].last_twitter_url, 'https://x.com/wsol');
  });

  it('defers monitored token promotion when Dex data is unavailable', async () => {
    mockDataAvailable = false;

    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'monitored-token',
        chain: 'solana',
      });

    assert.equal(res.status, 202);
    assert.equal(res.body.reason, 'dex_unavailable');
    assert.equal(typeof res.body.retryAt, 'number');
  });

  it('skips hotlink-blocked pumpfun image hosts and falls back to dex metadata', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes(`https://frontend-api.pump.fun/coins/${VALID_ADDR}`)) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              symbol: 'WSOL',
              name: 'Wrapped SOL',
              image_uri: 'https://metadata.j7tracker.io/images/blocked.png',
            };
          },
        };
      }

      throw new Error(`Unexpected fetch in pumpfun metadata test: ${url}`);
    };

    try {
      const res = await request(app)
        .get(`/api/catalog/pumpfun/${VALID_ADDR}/meta`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.mint, VALID_ADDR);
      assert.equal(res.body.imageUrl, 'https://example.com/token.png');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects private metadata URI lookups for pumpfun metadata', async () => {
    const res = await request(app)
      .get(`/api/catalog/pumpfun/${VALID_ADDR}/meta`)
      .set('Authorization', `Bearer ${token}`)
      .query({ uri: 'http://127.0.0.1:8787/private.json' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid metadata URI');
  });

  it('rejects malformed market history query params', async () => {
    const res = await request(app)
      .get(`/api/catalog/history/${VALID_ADDR}`)
      .set('Authorization', `Bearer ${token}`)
      .query({ hours: 'abc' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'hours must be an integer');
  });

  it('rejects malformed meteora history query params', async () => {
    const res = await request(app)
      .get(`/api/catalog/meteora/${VALID_ADDR}/history`)
      .set('Authorization', `Bearer ${token}`)
      .query({ limit: '1.5' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'limit must be an integer');
  });

  it('rejects malformed lateralized query params', async () => {
    const res = await request(app)
      .get('/api/catalog/lateralized')
      .set('Authorization', `Bearer ${token}`)
      .query({ hours: 'abc' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'hours must be an integer');
  });
});
