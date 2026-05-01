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

const VALID_ADDR = 'So11111111111111111111111111111111111111112';
const stamp = Date.now();
const ADMIN_USER = {
  username: `mockadmin_${stamp}`,
  email: `mockadmin_${stamp}@test.com`,
  password: 'TestPass123!',
};
const NORMAL_USER = {
  username: `mockuser_${stamp}`,
  email: `mockuser_${stamp}@test.com`,
  password: 'TestPass123!',
};

function getQueryToken(actionUrl) {
  const parsed = new URL(actionUrl);
  return parsed.searchParams.get('token');
}

async function verifyEmail(registerResponse) {
  const token = getQueryToken(registerResponse.body.emailDebug?.actionUrl);
  const res = await request(app).post('/api/auth/verify-email/confirm').send({ token });
  assert.equal(res.status, 200);
}

async function completeLogin(email, password) {
  const loginRes = await request(app).post('/api/auth/login').send({ email, password });
  assert.equal(loginRes.status, 200);
  const verifyRes = await request(app).post('/api/auth/login-otp/verify').send({
    challengeToken: loginRes.body.challengeToken,
    code: loginRes.body.emailDebug.otpCode,
  });
  assert.equal(verifyRes.status, 200);
  return verifyRes.body.token;
}

async function registerUser(user, inviteCode) {
  const res = await request(app).post('/api/auth/register').send({ ...user, inviteCode });
  assert.equal(res.status, 201);
  await verifyEmail(res);
  return res.body.user.id;
}

async function ensureMockTradingSchema() {
  const stage35 = require('../src/utils/db-init-stage35');
  await stage35.init({ closePool: false });
}

describe('mock trading admin routes', () => {
  let adminToken;
  let userToken;
  let adminUserId;

  before(async () => {
    await ensureMockTradingSchema();
    const invite = await Invite.create(null, { maxUses: 4, expiryHours: 24, grantAccessDays: 30 });

    adminUserId = await registerUser(ADMIN_USER, invite.code);
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminUserId]);
    adminToken = await completeLogin(ADMIN_USER.email, ADMIN_USER.password);

    await registerUser(NORMAL_USER, invite.code);
    userToken = await completeLogin(NORMAL_USER.email, NORMAL_USER.password);

    await db.query('DELETE FROM mock_trading_trades WHERE user_id = $1', [adminUserId]);
    await db.query('DELETE FROM mock_trading_positions WHERE user_id = $1', [adminUserId]);
    await db.query('DELETE FROM mock_trading_accounts WHERE user_id = $1', [adminUserId]);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);
    await db.query(
      `INSERT INTO token_catalog (
         address, chain, symbol, name, source, last_price, last_mcap, last_seen_at, last_evaluated_at
       )
       VALUES ($1, 'solana', 'WSOL', 'Wrapped SOL', 'mock-trading-test', 0.001, 100000, NOW(), NOW())`,
      [VALID_ADDR]
    );
  });

  after(async () => {
    await db.query('DELETE FROM mock_trading_trades WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM mock_trading_positions WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM mock_trading_accounts WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    if (server && server.close) server.close();
    await db.pool.end().catch(() => {});
  });

  it('rejects non-admin users', async () => {
    const res = await request(app)
      .get('/api/admin/mock-trading/summary')
      .set('Authorization', `Bearer ${userToken}`);

    assert.equal(res.status, 403);
  });

  it('executes buy, reports PnL percentage, sells, and resets', async () => {
    const buyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: VALID_ADDR, notionalUsd: 100 });

    assert.equal(buyRes.status, 201);
    assert.equal(buyRes.body.position.quantity, 100000);
    assert.equal(buyRes.body.position.avgEntryMcapUsd, 100000);

    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.002, last_mcap = 200000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const positionsRes = await request(app)
      .get('/api/admin/mock-trading/positions')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(positionsRes.status, 200);
    assert.equal(positionsRes.body.positions[0].unrealizedPnlUsd, 100);
    assert.equal(positionsRes.body.positions[0].priceReturnPct, 100);
    assert.equal(positionsRes.body.positions[0].mcapMultiple, 2);

    const sellRes = await request(app)
      .post('/api/admin/mock-trading/sell')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: VALID_ADDR, percent: 50 });

    assert.equal(sellRes.status, 200);
    assert.equal(sellRes.body.trade.realizedPnlUsd, 50);
    assert.equal(sellRes.body.trade.realizedPnlPct, 100);

    const resetRes = await request(app)
      .post('/api/admin/mock-trading/reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startingCashUsd: 5000 });

    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.account.cashUsd, 5000);
  });
});
