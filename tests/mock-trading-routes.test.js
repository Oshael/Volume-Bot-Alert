process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';
process.env.COINMARKETCAP_API_KEY = 'mock-trading-routes-cmc-key';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const originalFetch = global.fetch;
let currentSolUsd = 123.45;
global.fetch = async (url) => {
  const rawUrl = String(url);
  if (rawUrl.startsWith('https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: 5426,
          symbol: 'SOL',
          quote: {
            USD: {
              price: currentSolUsd,
              last_updated: new Date().toISOString(),
            },
          },
        }],
        status: { error_code: 0, timestamp: new Date().toISOString() },
      }),
    };
  }
  if (originalFetch) {
    return originalFetch(url);
  }
  throw new Error(`Unexpected fetch URL: ${rawUrl}`);
};

const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');
const mockTrading = require('../src/services/mock-trading-service');
const takeProfitWorker = require('../src/services/mock-trading-take-profit-worker');
const solUsdPrice = require('../src/services/sol-usd-price-service');

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

async function setSolUsdPrice(price) {
  currentSolUsd = price;
  const status = await solUsdPrice.fetchOnce();
  assert.equal(status.priceUsd, price);
  assert.equal(status.stale, false);
}

async function clearAdminMockTrading(adminUserId) {
  await db.query('DELETE FROM mock_trading_trades WHERE user_id = $1', [adminUserId]);
  await db.query('DELETE FROM mock_trading_take_profit_orders WHERE user_id = $1', [adminUserId]);
  await db.query('DELETE FROM mock_trading_positions WHERE user_id = $1', [adminUserId]);
  await db.query('DELETE FROM mock_trading_accounts WHERE user_id = $1', [adminUserId]);
  await db.query('DELETE FROM mock_trading_wallets WHERE user_id = $1', [adminUserId]);
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

    await clearAdminMockTrading(adminUserId);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);
    await db.query(
      `INSERT INTO token_catalog (
         address, chain, symbol, name, source, last_image_url, last_price, last_mcap, last_seen_at, last_evaluated_at
       )
       VALUES ($1, 'solana', 'WSOL', 'Wrapped SOL', 'mock-trading-test', 'https://example.test/wsol.png', 0.001, 100000, NOW(), NOW())`,
      [VALID_ADDR]
    );
    await setSolUsdPrice(123.45);
  });

  after(async () => {
    await db.query('DELETE FROM mock_trading_trades WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM mock_trading_take_profit_orders WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM mock_trading_positions WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM mock_trading_accounts WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM mock_trading_wallets WHERE user_id = $1', [adminUserId]).catch(() => {});
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    global.fetch = originalFetch;
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
    await setSolUsdPrice(100);

    const solPriceRes = await request(app)
      .get('/api/admin/mock-trading/sol-price')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(solPriceRes.status, 200);
    assert.equal(solPriceRes.body.priceUsd, 100);

    const buyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: VALID_ADDR, notionalSol: 1 });

    assert.equal(buyRes.status, 201);
    assert.equal(buyRes.body.position.quantity, 100000);
    assert.equal(buyRes.body.position.avgEntryMcapUsd, 100000);
    assert.equal(buyRes.body.trade.notionalUsd, 100);
    assert.equal(buyRes.body.trade.mockSolUsdcRate, 100);
    assert.equal(buyRes.body.trade.mockSolUsdcRateSource, 'coinmarketcap');
    assert.equal(buyRes.body.trade.metadata.mockSolUsdcRateSource, 'coinmarketcap');

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
    assert.equal(positionsRes.body.positions[0].imageUrl, 'https://example.test/wsol.png');

    const summaryRes = await request(app)
      .get('/api/admin/mock-trading/summary')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(summaryRes.status, 200);
    assert.equal(summaryRes.body.solUsdPrice.priceUsd, 100);

    await setSolUsdPrice(200);

    const sellRes = await request(app)
      .post('/api/admin/mock-trading/sell')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: VALID_ADDR, percent: 50 });

    assert.equal(sellRes.status, 200);
    assert.equal(sellRes.body.trade.realizedPnlUsd, 50);
    assert.equal(sellRes.body.trade.realizedPnlPct, 100);
    assert.equal(sellRes.body.trade.mockSolUsdcRate, 200);

    await db.query(
      `UPDATE token_catalog
       SET last_mcap = 25000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const tradesRes = await request(app)
      .get('/api/admin/mock-trading/trades')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(tradesRes.status, 200);
    const sellTrade = tradesRes.body.trades.find((trade) => trade.side === 'sell');
    assert.ok(sellTrade);
    assert.equal(sellTrade.symbol, 'WSOL');
    assert.equal(sellTrade.name, 'Wrapped SOL');
    assert.equal(sellTrade.imageUrl, 'https://example.test/wsol.png');
    assert.equal(sellTrade.mockSolUsdcRate, 200);
    const buyTrade = tradesRes.body.trades.find((trade) => trade.side === 'buy');
    assert.ok(buyTrade);
    assert.equal(buyTrade.mockSolUsdcRate, 100);

    const resetRes = await request(app)
      .post('/api/admin/mock-trading/reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startingCashUsd: 5000 });

    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.account.cashUsd, 5000);

    const addCashRes = await request(app)
      .post('/api/admin/mock-trading/add-cash')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountSol: 1.25 });

    assert.equal(addCashRes.status, 200);
    assert.equal(addCashRes.body.amountUsd, 250);
    assert.equal(addCashRes.body.account.cashUsd, 5250);
    assert.equal(addCashRes.body.account.startingCashUsd, 5250);
  });

  it('executes a take profit sell while the panel is closed', async () => {
    await clearAdminMockTrading(adminUserId);
    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.001, last_mcap = 100000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );
    await setSolUsdPrice(111);

    const buyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        address: VALID_ADDR,
        notionalUsd: 100,
        takeProfitMcapUsd: 200000,
        takeProfitSellPercent: 100,
      });

    assert.equal(buyRes.status, 201);
    assert.equal(buyRes.body.position.takeProfitOrder.targetMcapUsd, 200000);
    assert.equal(buyRes.body.position.takeProfitOrder.sellPercent, 100);

    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.002, last_mcap = 200000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );
    await setSolUsdPrice(222);

    const run = await takeProfitWorker.runOnce({ batchLimit: 5 });
    assert.equal(run.triggered, 1);

    const positionsRes = await request(app)
      .get('/api/admin/mock-trading/positions')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(positionsRes.status, 200);
    assert.equal(positionsRes.body.positions.length, 0);

    const tradesRes = await request(app)
      .get('/api/admin/mock-trading/trades')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(tradesRes.status, 200);
    const takeProfitSell = tradesRes.body.trades.find((trade) => trade.side === 'sell' && trade.source === 'take_profit');
    assert.ok(takeProfitSell);
    assert.equal(takeProfitSell.realizedPnlUsd, 100);
    assert.equal(takeProfitSell.mockSolUsdcRate, 222);
    assert.equal(takeProfitSell.metadata.mockSolUsdcRateSource, 'coinmarketcap');
    assert.equal(takeProfitSell.metadata.takeProfitOrderId, buyRes.body.position.takeProfitOrder.id);
  });

  it('allows multiple open sell orders per token and cancels one', async () => {
    await clearAdminMockTrading(adminUserId);
    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.001, last_mcap = 100000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const firstBuyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        address: VALID_ADDR,
        notionalUsd: 100,
        takeProfitMcapUsd: 200000,
        takeProfitSellPercent: 50,
      });

    assert.equal(firstBuyRes.status, 201);

    const secondBuyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        address: VALID_ADDR,
        notionalUsd: 100,
        takeProfitMcapUsd: 300000,
        takeProfitSellPercent: 50,
      });

    assert.equal(secondBuyRes.status, 201);
    assert.equal(secondBuyRes.body.position.takeProfitOrders.length, 2);

    const cancelRes = await request(app)
      .post(`/api/admin/mock-trading/take-profit-orders/${firstBuyRes.body.takeProfitOrder.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.order.status, 'cancelled');

    const positionsRes = await request(app)
      .get('/api/admin/mock-trading/positions')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(positionsRes.status, 200);
    assert.equal(positionsRes.body.positions[0].takeProfitOrders.length, 1);
    assert.equal(positionsRes.body.positions[0].takeProfitOrders[0].id, secondBuyRes.body.takeProfitOrder.id);
  });

  it('creates a sell order from an existing position without buying more', async () => {
    await clearAdminMockTrading(adminUserId);
    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.001, last_mcap = 100000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const buyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ address: VALID_ADDR, notionalUsd: 100 });

    assert.equal(buyRes.status, 201);
    assert.equal(buyRes.body.position.takeProfitOrders.length, 0);

    const orderRes = await request(app)
      .post('/api/admin/mock-trading/take-profit-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        address: VALID_ADDR,
        takeProfitMcapUsd: 250000,
        takeProfitSellPercent: 25,
      });

    assert.equal(orderRes.status, 201);
    assert.equal(orderRes.body.takeProfitOrder.targetMcapUsd, 250000);
    assert.equal(orderRes.body.takeProfitOrder.sellPercent, 25);
    assert.equal(orderRes.body.position.takeProfitOrders.length, 1);
    assert.equal(orderRes.body.position.quantity, buyRes.body.position.quantity);
  });

  it('scopes admin mock trading routes by wallet', async () => {
    await clearAdminMockTrading(adminUserId);
    await setSolUsdPrice(150);
    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.001, last_mcap = 100000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const walletsRes = await request(app)
      .get('/api/admin/mock-trading/wallets')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(walletsRes.status, 200);
    assert.equal(walletsRes.body.count, 1);
    assert.equal(walletsRes.body.wallets[0].name, 'Main');
    assert.equal(walletsRes.body.wallets[0].isDefault, true);
    const mainWallet = walletsRes.body.wallets[0];

    const secondWalletRes = await request(app)
      .post('/api/admin/mock-trading/wallets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Route Wallet ${stamp}` });

    assert.equal(secondWalletRes.status, 201);
    assert.equal(secondWalletRes.body.wallet.isDefault, false);
    const secondWallet = secondWalletRes.body.wallet;

    const newWalletSummaryRes = await request(app)
      .get(`/api/admin/mock-trading/summary?walletId=${secondWallet.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(newWalletSummaryRes.status, 200);
    assert.equal(newWalletSummaryRes.body.wallet.id, secondWallet.id);
    assert.equal(newWalletSummaryRes.body.account.cashUsd, 0);
    assert.equal(newWalletSummaryRes.body.account.startingCashUsd, 0);

    const renameRes = await request(app)
      .patch(`/api/admin/mock-trading/wallets/${secondWallet.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Route Wallet Renamed ${stamp}` });

    assert.equal(renameRes.status, 200);
    assert.equal(renameRes.body.wallet.name, `Route Wallet Renamed ${stamp}`);

    const archivedWalletRes = await request(app)
      .post('/api/admin/mock-trading/wallets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Route Wallet Archive ${stamp}` });

    assert.equal(archivedWalletRes.status, 201);

    const archiveRes = await request(app)
      .post(`/api/admin/mock-trading/wallets/${archivedWalletRes.body.wallet.id}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    assert.equal(archiveRes.status, 200);
    assert.ok(archiveRes.body.wallet.archivedAt);

    const defaultRes = await request(app)
      .post(`/api/admin/mock-trading/wallets/${secondWallet.id}/default`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    assert.equal(defaultRes.status, 200);
    assert.equal(defaultRes.body.wallet.id, secondWallet.id);
    assert.equal(defaultRes.body.wallet.isDefault, true);

    const defaultSummaryRes = await request(app)
      .get('/api/admin/mock-trading/summary')
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(defaultSummaryRes.status, 200);
    assert.equal(defaultSummaryRes.body.wallet.id, secondWallet.id);
    assert.equal(defaultSummaryRes.body.account.cashUsd, 0);

    const secondAddCashRes = await request(app)
      .post('/api/admin/mock-trading/add-cash')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ walletId: secondWallet.id, amountUsd: 300 });

    assert.equal(secondAddCashRes.status, 200);
    assert.equal(secondAddCashRes.body.account.cashUsd, 300);
    assert.equal(secondAddCashRes.body.account.startingCashUsd, 300);

    const mainBuyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ walletId: mainWallet.id, address: VALID_ADDR, notionalUsd: 100 });

    assert.equal(mainBuyRes.status, 201);
    assert.equal(mainBuyRes.body.wallet.id, mainWallet.id);
    assert.equal(mainBuyRes.body.position.quantity, 100000);

    const secondBuyRes = await request(app)
      .post('/api/admin/mock-trading/buy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ walletId: secondWallet.id, address: VALID_ADDR, notionalUsd: 200 });

    assert.equal(secondBuyRes.status, 201);
    assert.equal(secondBuyRes.body.wallet.id, secondWallet.id);
    assert.equal(secondBuyRes.body.position.quantity, 200000);

    const mainSellRes = await request(app)
      .post('/api/admin/mock-trading/sell')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ walletId: mainWallet.id, address: VALID_ADDR, percent: 100 });

    assert.equal(mainSellRes.status, 200);
    assert.equal(mainSellRes.body.wallet.id, mainWallet.id);

    const mainPositionsRes = await request(app)
      .get(`/api/admin/mock-trading/positions?walletId=${mainWallet.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const secondPositionsRes = await request(app)
      .get(`/api/admin/mock-trading/positions?walletId=${secondWallet.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(mainPositionsRes.status, 200);
    assert.equal(mainPositionsRes.body.positions.length, 0);
    assert.equal(secondPositionsRes.status, 200);
    assert.equal(secondPositionsRes.body.positions.length, 1);
    assert.equal(secondPositionsRes.body.positions[0].quantity, 200000);

    const orderRes = await request(app)
      .post('/api/admin/mock-trading/take-profit-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        walletId: secondWallet.id,
        address: VALID_ADDR,
        takeProfitMcapUsd: 200000,
        takeProfitSellPercent: 100,
      });

    assert.equal(orderRes.status, 201);
    assert.equal(orderRes.body.takeProfitOrder.walletId, secondWallet.id);

    const wrongWalletCancelRes = await request(app)
      .post(`/api/admin/mock-trading/take-profit-orders/${orderRes.body.takeProfitOrder.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ walletId: mainWallet.id });

    assert.equal(wrongWalletCancelRes.status, 404);

    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.002, last_mcap = 200000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const run = await takeProfitWorker.runOnce({ batchLimit: 5 });
    assert.equal(run.triggered, 1);

    const secondAfterTakeProfitRes = await request(app)
      .get(`/api/admin/mock-trading/positions?walletId=${secondWallet.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(secondAfterTakeProfitRes.status, 200);
    assert.equal(secondAfterTakeProfitRes.body.positions.length, 0);

    const secondTradesRes = await request(app)
      .get(`/api/admin/mock-trading/trades?walletId=${secondWallet.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(secondTradesRes.status, 200);
    assert.equal(secondTradesRes.body.trades.length, 2);
    assert.equal(secondTradesRes.body.trades.every((trade) => trade.walletId === secondWallet.id), true);
    assert.ok(secondTradesRes.body.trades.some((trade) => trade.side === 'sell' && trade.source === 'take_profit'));
  });

  it('keeps the same token isolated across mock trading wallets in the service layer', async () => {
    await clearAdminMockTrading(adminUserId);
    await setSolUsdPrice(150);
    await db.query(
      `UPDATE token_catalog
       SET last_price = 0.001, last_mcap = 100000, last_seen_at = NOW(), last_evaluated_at = NOW()
       WHERE address = $1`,
      [VALID_ADDR]
    );

    const [mainWallet] = await mockTrading.listWallets(adminUserId);
    const secondWallet = await mockTrading.createWallet({
      userId: adminUserId,
      name: `Wallet ${stamp}`,
    });
    const emptySecondSummary = await mockTrading.getSummary(adminUserId, { walletId: secondWallet.id });

    assert.equal(emptySecondSummary.account.cashUsd, 0);
    assert.equal(emptySecondSummary.account.startingCashUsd, 0);

    await mockTrading.addCash({
      userId: adminUserId,
      walletId: secondWallet.id,
      amountUsd: 300,
    });

    await mockTrading.buyToken({
      userId: adminUserId,
      walletId: mainWallet.id,
      address: VALID_ADDR,
      notionalUsd: 100,
    });
    await mockTrading.buyToken({
      userId: adminUserId,
      walletId: secondWallet.id,
      address: VALID_ADDR,
      notionalUsd: 200,
    });

    const mainBeforeSell = await mockTrading.getSummary(adminUserId, { walletId: mainWallet.id });
    const secondBeforeSell = await mockTrading.getSummary(adminUserId, { walletId: secondWallet.id });

    assert.equal(mainBeforeSell.wallet.id, mainWallet.id);
    assert.equal(mainBeforeSell.account.cashUsd, 900);
    assert.equal(mainBeforeSell.openPositionCount, 1);
    assert.equal(secondBeforeSell.wallet.id, secondWallet.id);
    assert.equal(secondBeforeSell.account.cashUsd, 100);
    assert.equal(secondBeforeSell.openPositionCount, 1);

    await mockTrading.sellToken({
      userId: adminUserId,
      walletId: mainWallet.id,
      address: VALID_ADDR,
      percent: 100,
    });

    const mainPositions = await mockTrading.listPositions(adminUserId, { walletId: mainWallet.id });
    const secondPositions = await mockTrading.listPositions(adminUserId, { walletId: secondWallet.id });
    const secondTrades = await mockTrading.listTrades({ userId: adminUserId, walletId: secondWallet.id });

    assert.equal(mainPositions.length, 0);
    assert.equal(secondPositions.length, 1);
    assert.equal(secondPositions[0].quantity, 200000);
    assert.equal(secondTrades.every((trade) => trade.walletId === secondWallet.id), true);
  });
});
