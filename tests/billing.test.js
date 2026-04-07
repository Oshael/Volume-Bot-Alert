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
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
}

describe('Billing foundation', () => {
  let server;
  let userToken;
  let lastOrderId = null;
  let originalFetch;

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
        key: 'plan-7d',
        label: '7 Days',
        description: 'Weekly access',
        accessDays: 7,
        currencyCode: 'USDC',
        amountMinor: 1500,
        featured: true,
        providerPaylinkId: 'paylink_test_7d',
      },
    ]);
    process.env.MOONPAY_COMMERCE_API_KEY = 'test-api-key';
    process.env.MOONPAY_COMMERCE_BEARER_TOKEN = 'test-bearer-token';
    process.env.MOONPAY_COMMERCE_WEBHOOK_TOKENS = 'test-webhook-token';

    originalFetch = global.fetch;
    global.fetch = async (url, init = {}) => {
      const targetUrl = String(url || '');
      if (targetUrl.includes('/charge/api-key')) {
        const body = {
          id: 'charge_test_1',
          pageUrl: 'https://checkout.example.test/charge/charge_test_1',
          status: 'pending',
        };
        return {
          ok: true,
          async text() {
            return JSON.stringify(body);
          },
        };
      }

      if (targetUrl.includes('/charge/charge_test_1')) {
        const body = {
          id: 'charge_test_1',
          pageUrl: 'https://checkout.example.test/charge/charge_test_1',
          status: 'pending',
        };
        return {
          ok: true,
          async text() {
            return JSON.stringify(body);
          },
        };
      }

      throw new Error(`Unexpected fetch call in test: ${targetUrl}`);
    };

    const { pool } = require('../src/models/db');
    await ensureSchemas(pool);
    await pool.query('DELETE FROM billing_events');
    await pool.query('DELETE FROM billing_orders');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
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
    assert.equal(res.body.plans[0].key, 'plan-7d');
  });

  it('returns billing plans publicly without requiring authentication', async () => {
    const res = await request('GET', '/api/billing/plans');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.provider, 'moonpay_commerce');
    assert.equal(res.body.providerReady, true);
    assert.equal(res.body.plans.length, 1);
    assert.equal(res.body.plans[0].key, 'plan-7d');
  });

  it('creates a MoonPay billing order', async () => {
    const res = await request('POST', '/api/billing/orders', {
      token: userToken,
      body: { planKey: 'plan-7d' },
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'awaiting_payment');
    assert.equal(res.body.order.planKey, 'plan-7d');
    assert.equal(res.body.checkoutUrl, 'https://checkout.example.test/charge/charge_test_1');
    lastOrderId = res.body.order.id;
  });

  it('lists created billing order', async () => {
    const res = await request('GET', '/api/billing/orders', { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 1);
    assert.equal(res.body.orders[0].status, 'awaiting_payment');
  });

  it('processes MoonPay webhook and credits access', async () => {
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
                billingPlanKey: 'plan-7d',
              }),
            },
          },
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.ignored, false);

    const ordersResponse = await request('GET', '/api/billing/orders', { token: userToken });
    assert.equal(ordersResponse.status, 200);
    assert.equal(ordersResponse.body.orders[0].status, 'paid');
    assert.ok(ordersResponse.body.orders[0].paidAt);

    const accessResponse = await request('GET', '/api/account/access', { token: userToken });
    assert.equal(accessResponse.status, 200);
    assert.equal(accessResponse.body.accessSource, 'payment');
    assert.equal(accessResponse.body.accessStatus, 'active');
    assert.ok(accessResponse.body.accessExpiresAt);
    assert.ok(accessResponse.body.daysRemaining >= 7);
  });

  it('serves an internal receipt for paid billing orders', async () => {
    const res = await request('GET', `/api/account-security/billing/orders/${lastOrderId}/receipt`, { token: userToken });
    assert.equal(res.status, 200);
    assert.match(String(res.body || ''), /TrendScope Payment Receipt/i);
    assert.match(String(res.body || ''), /7 Days/);
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
        body: { planKey: 'plan-7d' },
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
