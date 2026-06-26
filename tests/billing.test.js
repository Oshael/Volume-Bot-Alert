const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function request(method, path, { body, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: process.env.TEST_PORT || 3100,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
      },
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
  const parsed = new URL(actionUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token, 'Expected token query param in actionUrl');
  return token;
}

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.emailVerificationRequired, true);
  const verificationToken = getQueryToken(registerResponse.body.emailDebug.actionUrl);
  const verifyResponse = await request('POST', '/api/auth/verify-email/confirm', {
    body: { token: verificationToken },
  });
  assert.equal(verifyResponse.status, 200);
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

async function ensureSchemas(pool) {
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
    `CREATE TABLE IF NOT EXISTS billing_orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_key VARCHAR(64) NOT NULL,
      plan_name VARCHAR(128) NOT NULL,
      access_days INTEGER NOT NULL,
      provider VARCHAR(32) NOT NULL,
      provider_paylink_id VARCHAR(128),
      provider_charge_id VARCHAR(128),
      provider_charge_token VARCHAR(128),
      provider_checkout_url TEXT,
      provider_status VARCHAR(32),
      currency_code VARCHAR(16) NOT NULL,
      currency_amount_minor BIGINT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      checkout_expires_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      last_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS billing_events (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES billing_orders(id) ON DELETE SET NULL,
      provider VARCHAR(32) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      provider_event_id VARCHAR(128),
      delivery_idempotency_key VARCHAR(255),
      transaction_idempotency_key VARCHAR(255),
      process_status VARCHAR(32) NOT NULL DEFAULT 'received',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS user_wallets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wallet_address VARCHAR(64) NOT NULL,
      chain VARCHAR(16) NOT NULL DEFAULT 'solana',
      wallet_provider VARCHAR(64),
      is_primary BOOLEAN NOT NULL DEFAULT true,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      last_verified_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_wallet_address
      ON user_wallets(wallet_address)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_user_id
      ON user_wallets(user_id)`,
    `CREATE TABLE IF NOT EXISTS token_holding_snapshots (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wallet_address VARCHAR(64) NOT NULL,
      mint_address VARCHAR(64) NOT NULL,
      token_program VARCHAR(128),
      decimals INTEGER NOT NULL,
      balance_raw TEXT NOT NULL,
      balance_ui_string TEXT,
      tier VARCHAR(32) NOT NULL DEFAULT 'none',
      discount_percent INTEGER NOT NULL DEFAULT 0,
      has_unlimited_access BOOLEAN NOT NULL DEFAULT false,
      has_launch_promo_access BOOLEAN NOT NULL DEFAULT false,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      rpc_provider VARCHAR(64),
      rpc_slot BIGINT,
      rpc_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE INDEX IF NOT EXISTS idx_token_holding_snapshots_user_checked
      ON token_holding_snapshots(user_id, checked_at DESC, id DESC)`,
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function buildChargeLookupBody({
  chargeId,
  paylinkId = 'paylink_test_30d',
  requestAmount = '49',
  currencySymbol = 'USDC',
  transactionId = null,
  transactionSignature = null,
  transactionStatus = 'SUCCESS',
  tokenQuoteFromAmountDecimal = null,
} = {}) {
  return {
    id: chargeId,
    pageUrl: `https://checkout.example.test/charge/${chargeId}`,
    status: transactionId ? 'paid' : 'pending',
    currencySymbol,
    requestAmount,
    prepareRequestBody: {
      currency: currencySymbol,
      amount: requestAmount,
      quantity: 1,
    },
    paylink: {
      id: paylinkId,
      price: requestAmount,
      normalizedPrice: requestAmount,
      pricingCurrency: {
        symbol: currencySymbol,
      },
    },
    paylinkTx: transactionId ? {
      id: transactionId,
      paylinkId,
      meta: {
        transactionSignature: transactionSignature || `sig_${transactionId}`,
        transactionStatus,
        tokenQuote: tokenQuoteFromAmountDecimal ? {
          from: currencySymbol,
          fromAmountDecimal: tokenQuoteFromAmountDecimal,
          to: currencySymbol,
          toAmountMinimal: requestAmount,
        } : undefined,
        currency: {
          symbol: currencySymbol,
        },
      },
    } : null,
  };
}

describe('Billing foundation', () => {
  let server;
  let userToken;
  let lastOrderId = null;
  let lastOrderChargeId = null;
  let tokenDiscountUserToken;
  let tokenDiscountUserId;
  let tokenDiscountOrderId;
  let tokenDiscountOrderChargeId;
  let originalFetch;
  let createdChargeCount = 0;
  let createdChargeLookups;
  let chargeLookupOverrides;
  let transientLookupFailures;
  let heliusBalanceRaw;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3100';
    process.env.TEST_PORT = '3100';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100';
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_PROVIDER = 'local';
    process.env.EMAIL_FROM = 'tests@trendscope.local';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';
    process.env.BILLING_ENABLED = 'true';
    process.env.BILLING_CHECKOUT_RETURN_URL = 'http://localhost:5173/access';
    process.env.BILLING_PLANS_JSON = JSON.stringify([
      {
        key: 'plan-30d',
        label: '30 Days',
        description: 'Monthly access',
        accessDays: 30,
        currencyCode: 'USDC',
        amountMinor: 4900,
        featured: true,
        providerPaylinkId: 'paylink_test_30d',
        providerPaylinkDynamic: true,
      },
    ]);
    process.env.MOONPAY_COMMERCE_API_KEY = 'test-api-key';
    process.env.MOONPAY_COMMERCE_BEARER_TOKEN = 'test-bearer-token';
    process.env.MOONPAY_COMMERCE_WEBHOOK_TOKENS = 'test-webhook-token';
    process.env.HELIUS_API_KEY = 'test-helius-key';
    process.env.TOKEN_GATE_ENABLED = 'true';
    process.env.TOKEN_GATE_MINT_ADDRESS = 'DiscountMint111111111111111111111111111111111';
    process.env.TOKEN_GATE_BALANCE_CACHE_SECONDS = '60';
    process.env.TOKEN_GATE_UNLIMITED_THRESHOLD = '2000000';
    process.env.TOKEN_GATE_DISCOUNT_THRESHOLD = '1000000';
    process.env.TOKEN_GATE_DISCOUNT_PERCENT = '50';
    process.env.TOKEN_GATE_LAUNCH_PROMO_ENABLED = 'false';

    originalFetch = global.fetch;
    createdChargeLookups = new Map();
    chargeLookupOverrides = new Map();
    transientLookupFailures = new Map();
    heliusBalanceRaw = '1000000000000';
    global.fetch = async (url, init = {}) => {
      const targetUrl = String(url || '');
      if (targetUrl.includes('/charge/api-key')) {
        createdChargeCount += 1;
        const chargeId = `charge_test_${createdChargeCount}`;
        const requestBody = JSON.parse(String(init.body || '{}'));
        const paylinkId = requestBody?.paymentRequestId || 'paylink_test_30d';
        const requestAmount = requestBody?.requestAmount || '49';
        const body = {
          id: chargeId,
          pageUrl: `https://checkout.example.test/charge/${chargeId}`,
          status: 'pending',
        };
        createdChargeLookups.set(chargeId, buildChargeLookupBody({
          chargeId,
          paylinkId,
          requestAmount,
          currencySymbol: 'USDC',
        }));
        return jsonResponse(body);
      }

      if (targetUrl.includes('helius-rpc.com')) {
        const requestBody = JSON.parse(String(init.body || '{}'));
        if (requestBody.method === 'getTokenSupply') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: requestBody.id,
            result: {
              context: { slot: 123 },
              value: { decimals: 6 },
            },
          });
        }
        if (requestBody.method === 'getTokenAccounts') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: requestBody.id,
            result: {
              context: { slot: 123 },
              token_accounts: [{
                amount: heliusBalanceRaw,
                token_program: 'Tokenkeg1111111111111111111111111111111111',
              }],
            },
          });
        }
      }

      const chargeMatch = targetUrl.match(/\/charge\/([^/?]+)/);
      if (chargeMatch) {
        const chargeId = decodeURIComponent(chargeMatch[1]);
        const remainingFailures = transientLookupFailures.get(chargeId) || 0;
        if (remainingFailures > 0) {
          transientLookupFailures.set(chargeId, remainingFailures - 1);
          throw new Error(`Simulated transient charge lookup failure for ${chargeId}`);
        }

        const body = chargeLookupOverrides.get(chargeId)
          || createdChargeLookups.get(chargeId)
          || buildChargeLookupBody({ chargeId });
        return jsonResponse(body);
      }

      throw new Error(`Unexpected fetch call in test: ${targetUrl}`);
    };

    const { pool } = require('../src/models/db');
    const { assertUsingTestDatabase } = require('./helpers/test-db');

    await assertUsingTestDatabase(pool);
    await ensureSchemas(pool);
    await pool.query('DELETE FROM billing_events');
    await pool.query('DELETE FROM billing_orders');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('DELETE FROM token_holding_snapshots');
    await pool.query('DELETE FROM user_wallets');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM invites');
    await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});
    await pool.query(
      `INSERT INTO invites (code, created_by, max_uses, grant_access_days, grant_access_source, expires_at)
       VALUES ('BILLINGTEST0001', NULL, 10, 30, 'invite', NOW() + INTERVAL '24 hours')`
    );

    const { startServer } = require('../src/server');
    server = startServer(3100);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const registerResponse = await request('POST', '/api/auth/register', {
      body: { username: 'billinguser', email: 'billing@test.com', password: 'billingpass123', inviteCode: 'BILLINGTEST0001' },
    });
    await verifyEmailFromRegisterResponse(registerResponse);
    userToken = await completeLogin('billing@test.com', 'billingpass123');

    const tokenRegisterResponse = await request('POST', '/api/auth/register', {
      body: {
        username: 'billingtokenuser',
        email: 'billing-token@test.com',
        password: 'billingpass123',
        inviteCode: 'BILLINGTEST0001',
      },
    });
    await verifyEmailFromRegisterResponse(tokenRegisterResponse);
    tokenDiscountUserToken = await completeLogin('billing-token@test.com', 'billingpass123');
    const tokenMeResponse = await request('GET', '/api/auth/me', { token: tokenDiscountUserToken });
    assert.equal(tokenMeResponse.status, 200);
    tokenDiscountUserId = tokenMeResponse.body.user.id;
    await pool.query(
      `INSERT INTO user_wallets (user_id, wallet_address, chain, wallet_provider, is_primary, last_verified_at)
       VALUES ($1, $2, 'solana', 'phantom', true, NOW())`,
      [tokenDiscountUserId, 'DiscountWallet1111111111111111111111111111111']
    );
  });

  after(async () => {
    global.fetch = originalFetch;
    const socketHub = require('../src/services/socket-hub');
    socketHub.stop();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const { pool } = require('../src/models/db');
    await pool.end();
  });

  it('returns billing plans and empty order history', async () => {
    const res = await request('GET', '/api/billing/state', { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.provider, 'moonpay_commerce');
    assert.equal(res.body.providerReady, true);
    assert.equal(res.body.plans.length, 1);
    assert.equal(res.body.orders.length, 0);
    assert.equal(res.body.plans[0].key, 'plan-30d');
  });

  it('returns billing plans publicly without requiring authentication', async () => {
    const res = await request('GET', '/api/billing/plans');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.provider, 'moonpay_commerce');
    assert.equal(res.body.providerReady, true);
    assert.equal(res.body.plans.length, 1);
    assert.equal(res.body.plans[0].key, 'plan-30d');
  });

  it('creates a MoonPay billing order', async () => {
    const res = await request('POST', '/api/billing/orders', {
      token: userToken,
      body: { planKey: 'plan-30d' },
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'awaiting_payment');
    assert.equal(res.body.order.planKey, 'plan-30d');
    assert.equal(res.body.checkoutUrl, 'https://checkout.example.test/charge/charge_test_1');
    assert.equal(res.body.order.metadata.pricing.providerPaylinkDynamic, true);
    assert.equal(res.body.order.metadata.pricing.providerRequestAmount, '49');
    lastOrderId = res.body.order.id;
    lastOrderChargeId = res.body.order.providerChargeId;
    assert.equal(
      res.body.order.metadata.successRedirectUrl,
      `http://localhost:5173/access?billing=success&billingOrderId=${lastOrderId}`
    );
  });

  it('creates a discounted billing order for a linked wallet token holder', async () => {
    const res = await request('POST', '/api/billing/orders', {
      token: tokenDiscountUserToken,
      body: { planKey: 'plan-30d' },
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'awaiting_payment');
    assert.equal(res.body.order.currencyAmountMinor, 2450);
    assert.equal(res.body.order.providerPaylinkId, 'paylink_test_30d');
    assert.equal(res.body.order.metadata.pricing.baseAmountMinor, 4900);
    assert.equal(res.body.order.metadata.pricing.finalAmountMinor, 2450);
    assert.equal(res.body.order.metadata.pricing.discountAmountMinor, 2450);
    assert.equal(res.body.order.metadata.pricing.discountPercent, 50);
    assert.equal(res.body.order.metadata.pricing.discountApplied, true);
    assert.equal(res.body.order.metadata.pricing.providerPaylinkDynamic, true);
    assert.equal(res.body.order.metadata.pricing.providerRequestAmount, '24.5');
    assert.equal(res.body.order.metadata.tokenDiscount.tokenTier, 'discount_50');
    assert.equal(res.body.order.metadata.tokenDiscount.discountPercent, 50);
    assert.equal(res.body.order.metadata.tokenDiscount.tokenBalanceRaw, '1000000000000');
    assert.ok(res.body.order.metadata.tokenDiscount.tokenSnapshotId);
    tokenDiscountOrderId = res.body.order.id;
    tokenDiscountOrderChargeId = res.body.order.providerChargeId;

    const stateResponse = await request('GET', '/api/billing/state', { token: tokenDiscountUserToken });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.body.plans[0].discountAvailable, true);
    assert.equal(stateResponse.body.plans[0].discountedAmountMinor, 2450);
    assert.equal(stateResponse.body.plans[0].discountPercent, 50);
  });

  it('lists created billing order', async () => {
    const res = await request('GET', '/api/billing/orders', { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 1);
    assert.equal(res.body.orders[0].status, 'awaiting_payment');
  });

  it('processes MoonPay webhook and credits access', async () => {
    chargeLookupOverrides.set(lastOrderChargeId, buildChargeLookupBody({
      chargeId: lastOrderChargeId,
      paylinkId: 'paylink_test_30d',
      requestAmount: '49',
      currencySymbol: 'USDC',
      transactionId: 'txn_test_1',
      transactionSignature: 'sig_test_1',
      transactionStatus: 'SUCCESS',
    }));

    const res = await request('POST', '/api/billing/webhooks/moonpay', {
      headers: {
        Authorization: 'Bearer test-webhook-token',
      },
      body: {
        event: 'CREATED',
        transactionObject: {
          id: 'txn_test_1',
          meta: {
            transactionStatus: 'SUCCESS',
            transactionSignature: 'sig_test_1',
            customerDetails: {
              additionalJSON: JSON.stringify({
                billingOrderId: lastOrderId,
                billingPlanKey: 'plan-30d',
              }),
            },
          },
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.ignored, false);
    assert.equal(res.body.rejected, false);

    const ordersResponse = await request('GET', '/api/billing/orders', { token: userToken });
    assert.equal(ordersResponse.status, 200);
    assert.equal(ordersResponse.body.orders[0].status, 'paid');
    assert.ok(ordersResponse.body.orders[0].paidAt);

    const accessResponse = await request('GET', '/api/account/access', { token: userToken });
    assert.equal(accessResponse.status, 200);
    assert.equal(accessResponse.body.accessSource, 'payment');
    assert.equal(accessResponse.body.accessStatus, 'active');
    assert.ok(accessResponse.body.accessExpiresAt);
    assert.ok(accessResponse.body.daysRemaining >= 30);
  });

  it('processes a discounted webhook and preserves paid access after token balance drops', async () => {
    chargeLookupOverrides.set(tokenDiscountOrderChargeId, buildChargeLookupBody({
      chargeId: tokenDiscountOrderChargeId,
      paylinkId: 'paylink_test_30d',
      requestAmount: '24.5',
      currencySymbol: 'USDC',
      transactionId: 'txn_token_discount_1',
      transactionSignature: 'sig_token_discount_1',
      transactionStatus: 'SUCCESS',
    }));

    const res = await request('POST', '/api/billing/webhooks/moonpay', {
      headers: {
        Authorization: 'Bearer test-webhook-token',
      },
      body: {
        event: 'CREATED',
        webhookDeliveryIdempotencyKey: 'token_discount_delivery_1',
        transactionObject: {
          id: 'txn_token_discount_1',
          meta: {
            transactionStatus: 'SUCCESS',
            transactionSignature: 'sig_token_discount_1',
            customerDetails: {
              additionalJSON: JSON.stringify({
                billingOrderId: tokenDiscountOrderId,
                billingPlanKey: 'plan-30d',
                appUserId: tokenDiscountUserId,
              }),
            },
          },
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.ignored, false);
    assert.equal(res.body.rejected, false);

    heliusBalanceRaw = '1';
    const snapshotModel = require('../src/models/token-holding-snapshot');
    await snapshotModel.createSnapshot({
      userId: tokenDiscountUserId,
      walletAddress: 'DiscountWallet1111111111111111111111111111111',
      mintAddress: 'DiscountMint111111111111111111111111111111111',
      decimals: 6,
      balanceRaw: '1',
      balanceUiString: '0.000001',
      tier: 'none',
      discountPercent: 0,
      hasUnlimitedAccess: false,
      hasLaunchPromoAccess: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      rpcProvider: 'helius',
      rpcSlot: 124,
    });

    const accessResponse = await request('GET', '/api/account/access', { token: tokenDiscountUserToken });
    assert.equal(accessResponse.status, 200);
    assert.equal(accessResponse.body.accessSource, 'payment');
    assert.equal(accessResponse.body.accessStatus, 'active');
    assert.equal(accessResponse.body.hasProductAccess, true);
    assert.equal(accessResponse.body.tokenTier, 'none');
    assert.equal(accessResponse.body.discountPercent, 0);
  });

  it('serves an internal receipt for paid billing orders', async () => {
    const res = await request('GET', `/api/account-security/billing/orders/${lastOrderId}/receipt`, { token: userToken });
    assert.equal(res.status, 200);
    assert.match(String(res.body || ''), /TrendScope Payment Receipt/i);
    assert.match(String(res.body || ''), /30 Days/);
    assert.match(String(res.body || ''), /sig_test_1/);
    assert.match(String(res.body || ''), /TS-/);
  });

  it('treats duplicate webhook delivery as idempotent', async () => {
    const res = await request('POST', '/api/billing/webhooks/moonpay', {
      headers: {
        Authorization: 'Bearer test-webhook-token',
      },
      body: {
        event: 'CREATED',
        transactionObject: {
          id: 'txn_test_1',
          meta: {
            transactionStatus: 'SUCCESS',
            transactionSignature: 'sig_test_1',
            customerDetails: {
              additionalJSON: JSON.stringify({
                billingOrderId: lastOrderId,
              }),
            },
          },
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, true);
  });

  it('rejects webhook when provider charge reconciliation does not match local order', async () => {
    const orderResponse = await request('POST', '/api/billing/orders', {
      token: userToken,
      body: { planKey: 'plan-30d' },
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    assert.equal(orderResponse.status, 201);
    const rejectedOrderId = orderResponse.body.order.id;
    const rejectedChargeId = orderResponse.body.order.providerChargeId;
    const rejectedUserId = orderResponse.body.order.userId;

    chargeLookupOverrides.set(rejectedChargeId, buildChargeLookupBody({
      chargeId: rejectedChargeId,
      paylinkId: 'paylink_wrong',
      requestAmount: '49',
      currencySymbol: 'USDC',
      transactionId: 'txn_reject_1',
      transactionSignature: 'sig_reject_1',
      transactionStatus: 'SUCCESS',
    }));

    const res = await request('POST', '/api/billing/webhooks/moonpay', {
      headers: {
        Authorization: 'Bearer test-webhook-token',
      },
      body: {
        event: 'CREATED',
        webhookDeliveryIdempotencyKey: 'reject_test_delivery_1',
        transactionObject: {
          id: 'txn_reject_1',
          meta: {
            transactionStatus: 'SUCCESS',
            transactionSignature: 'sig_reject_1',
            customerDetails: {
              additionalJSON: JSON.stringify({
                billingOrderId: rejectedOrderId,
                billingPlanKey: 'plan-30d',
                appUserId: rejectedUserId,
              }),
            },
          },
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.ignored, true);
    assert.equal(res.body.rejected, true);
    assert.match(String(res.body.reason || ''), /paylink id/i);

    const ordersResponse = await request('GET', '/api/billing/orders', { token: userToken });
    assert.equal(ordersResponse.status, 200);
    const rejectedOrder = ordersResponse.body.orders.find((entry) => entry.id === rejectedOrderId);
    assert.ok(rejectedOrder);
    assert.equal(rejectedOrder.status, 'awaiting_payment');
  });

  it('syncs a paid provider charge when the webhook did not arrive', async () => {
    const orderResponse = await request('POST', '/api/billing/orders', {
      token: userToken,
      body: { planKey: 'plan-30d' },
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    assert.equal(orderResponse.status, 201);
    const syncOrderId = orderResponse.body.order.id;
    const syncChargeId = orderResponse.body.order.providerChargeId;
    const syncUserId = orderResponse.body.order.userId;

    chargeLookupOverrides.set(syncChargeId, buildChargeLookupBody({
      chargeId: syncChargeId,
      paylinkId: 'paylink_test_30d',
      requestAmount: '49000000',
      tokenQuoteFromAmountDecimal: '49',
      currencySymbol: 'USDC',
      transactionId: 'txn_sync_1',
      transactionSignature: 'sig_sync_1',
      transactionStatus: 'SUCCESS',
    }));

    const billingService = require('../src/services/billing-service');
    const result = await billingService.syncOrderPaymentFromProvider({ id: syncUserId }, syncOrderId);

    assert.equal(result.synced, true);
    assert.equal(result.order.status, 'paid');
    assert.equal(result.order.metadata.providerChargeLookupAmount, '49');
    assert.equal(result.order.metadata.providerTransactionSignature, 'sig_sync_1');
  });

  it('retries a received webhook after transient provider lookup failure', async () => {
    const orderResponse = await request('POST', '/api/billing/orders', {
      token: userToken,
      body: { planKey: 'plan-30d' },
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    assert.equal(orderResponse.status, 201);
    const retryOrderId = orderResponse.body.order.id;
    const retryChargeId = orderResponse.body.order.providerChargeId;

    chargeLookupOverrides.set(retryChargeId, buildChargeLookupBody({
      chargeId: retryChargeId,
      paylinkId: 'paylink_test_30d',
      requestAmount: '49',
      currencySymbol: 'USDC',
      transactionId: 'txn_retry_1',
      transactionSignature: 'sig_retry_1',
      transactionStatus: 'SUCCESS',
    }));
    transientLookupFailures.set(retryChargeId, 1);

    const payload = {
      event: 'CREATED',
      webhookDeliveryIdempotencyKey: 'retry_test_delivery_1',
      transactionObject: {
        id: 'txn_retry_1',
        meta: {
          transactionStatus: 'SUCCESS',
          transactionSignature: 'sig_retry_1',
          customerDetails: {
            additionalJSON: JSON.stringify({
              billingOrderId: retryOrderId,
              billingPlanKey: 'plan-30d',
            }),
          },
        },
      },
    };

    const firstResponse = await request('POST', '/api/billing/webhooks/moonpay', {
      headers: {
        Authorization: 'Bearer test-webhook-token',
      },
      body: payload,
    });
    assert.equal(firstResponse.status, 500);

    const retryResponse = await request('POST', '/api/billing/webhooks/moonpay', {
      headers: {
        Authorization: 'Bearer test-webhook-token',
      },
      body: payload,
    });
    assert.equal(retryResponse.status, 200);
    assert.equal(retryResponse.body.duplicate, false);
    assert.equal(retryResponse.body.ignored, false);
    assert.equal(retryResponse.body.rejected, false);

    const ordersResponse = await request('GET', '/api/billing/orders', { token: userToken });
    assert.equal(ordersResponse.status, 200);
    const retryOrder = ordersResponse.body.orders.find((entry) => entry.id === retryOrderId);
    assert.ok(retryOrder);
    assert.equal(retryOrder.status, 'paid');
  });

  it('keeps mock checkout disabled when mock mode is off', async () => {
    const res = await request('GET', `/api/billing/mock-checkout/${lastOrderId}`, { token: userToken });
    assert.equal(res.status, 404);
  });

  it('requires auth and loopback host for mock checkout when mock mode is enabled', async () => {
    const config = require('../config');
    const originalMockMode = config.billing.moonpay.mockMode;
    config.billing.moonpay.mockMode = true;

    try {
      const orderResponse = await request('POST', '/api/billing/orders', {
        token: userToken,
        body: { planKey: 'plan-30d' },
        headers: {
          Origin: 'http://localhost:3000',
        },
      });

      assert.equal(orderResponse.status, 201);
      assert.match(String(orderResponse.body.checkoutUrl || ''), /\/api\/billing\/mock-checkout\//i);

      const mockCheckoutPath = new URL(orderResponse.body.checkoutUrl).pathname;

      const unauthenticatedGet = await request('GET', mockCheckoutPath);
      assert.equal(unauthenticatedGet.status, 401);

      const nonLoopbackHostGet = await request('GET', mockCheckoutPath, {
        token: userToken,
        headers: {
          Host: 'evil.example.test',
        },
      });
      assert.equal(nonLoopbackHostGet.status, 404);

      const authenticatedGet = await request('GET', mockCheckoutPath, { token: userToken });
      assert.equal(authenticatedGet.status, 200);
      assert.match(String(authenticatedGet.body || ''), /Local Billing Mock Checkout/i);

      const completeResponse = await request('POST', `${mockCheckoutPath}/complete`, { token: userToken });
      assert.equal(completeResponse.status, 200);
      assert.match(String(completeResponse.body || ''), /Mock Payment Confirmed/i);

      const ordersResponse = await request('GET', '/api/billing/orders', { token: userToken });
      assert.equal(ordersResponse.status, 200);
      assert.equal(ordersResponse.body.orders[0].status, 'paid');
    } finally {
      config.billing.moonpay.mockMode = originalMockMode;
    }
  });
});
