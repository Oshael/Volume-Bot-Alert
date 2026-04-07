const express = require('express');
const config = require('../../config');
const { authenticateAllowExpiredAccess, requireTrustedOrigin } = require('../middleware/auth');
const billingOrder = require('../models/billing-order');
const billingCatalog = require('../services/billing-catalog');
const billingService = require('../services/billing-service');

const router = express.Router();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMockCheckoutHtml(order) {
  const planName = escapeHtml(order?.planName || 'Unknown plan');
  const price = escapeHtml(`${String(order?.currencyCode || '').trim().toUpperCase()} ${(Number(order?.currencyAmountMinor || 0) / 100).toFixed(2)}`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local Billing Mock Checkout</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: Arial, sans-serif; background: #07111d; color: #e9f1ff; }
      main { max-width: 720px; margin: 48px auto; padding: 32px; background: #0f1b2b; border: 1px solid #214064; border-radius: 20px; }
      h1 { margin-top: 0; font-size: 32px; }
      p, li { color: #b8c9e2; line-height: 1.6; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 12px 18px; margin: 24px 0; }
      dt { color: #7fa0c7; }
      dd { margin: 0; font-weight: 700; }
      button { border: 0; border-radius: 12px; background: #00f58c; color: #04140d; font-weight: 800; padding: 14px 22px; cursor: pointer; }
      .muted { margin-top: 20px; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Local Billing Mock Checkout</h1>
      <p>This page exists only for local development. No real MoonPay request or blockchain payment will happen here.</p>
      <dl>
        <dt>Order</dt><dd>#${order.id}</dd>
        <dt>Plan</dt><dd>${planName}</dd>
        <dt>Price</dt><dd>${price}</dd>
        <dt>Status</dt><dd>${escapeHtml(order.status || 'pending')}</dd>
      </dl>
      <form method="post" action="/api/billing/mock-checkout/${order.id}/complete">
        <button type="submit">Simulate Successful Payment</button>
      </form>
      <p class="muted">After confirmation, the backend will process the same internal access-crediting path used by the real webhook flow.</p>
    </main>
  </body>
  </html>`;
}

function getMockCheckoutSuccessHtml({ order, redirectUrl }) {
  const safeRedirectUrl = escapeHtml(redirectUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mock Payment Confirmed</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: Arial, sans-serif; background: #07111d; color: #e9f1ff; }
      main { max-width: 720px; margin: 48px auto; padding: 32px; background: #0f1b2b; border: 1px solid #214064; border-radius: 20px; }
      h1 { margin-top: 0; font-size: 32px; }
      p { color: #b8c9e2; line-height: 1.6; }
      a { color: #00f58c; font-weight: 700; }
    </style>
    <script>
      window.setTimeout(function redirectToApp() {
        window.location.replace(${JSON.stringify(redirectUrl)});
      }, 350);
    </script>
  </head>
  <body>
    <main>
      <h1>Mock Payment Confirmed</h1>
      <p>Order #${order.id} was marked as paid in the local mock flow.</p>
      <p>Redirecting back to the app now...</p>
      <p>If nothing happens, continue manually: <a href="${safeRedirectUrl}">${safeRedirectUrl}</a></p>
    </main>
  </body>
</html>`;
}

function isLoopbackValue(value) {
  return LOOPBACK_HOSTS.has(String(value || '').trim().toLowerCase());
}

function isLocalMockCheckoutRequest(req) {
  const hostname = String(req.hostname || req.get('host') || '').split(':')[0];
  const isLocalEnv = config.nodeEnv === 'development' || config.nodeEnv === 'test';
  return isLocalEnv && isLoopbackValue(hostname);
}

function requireLocalMockCheckout(req, res, next) {
  if (!billingCatalog.isMoonpayMockMode()) {
    return res.status(404).send('Not found');
  }

  if (!isLocalMockCheckoutRequest(req)) {
    return res.status(404).send('Not found');
  }

  return next();
}

router.get('/mock-checkout/:orderId', requireLocalMockCheckout, authenticateAllowExpiredAccess, async (req, res) => {
  if (!billingCatalog.isMoonpayMockMode()) {
    return res.status(404).send('Not found');
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).send('Invalid order id');
  }

  const order = await billingOrder.findByIdForUser(orderId, req.user.id);
  if (!order) {
    return res.status(404).send('Billing order not found');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(getMockCheckoutHtml(order));
});

router.post('/mock-checkout/:orderId/complete', requireLocalMockCheckout, authenticateAllowExpiredAccess, async (req, res) => {
  if (!billingCatalog.isMoonpayMockMode()) {
    return res.status(404).send('Not found');
  }

  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).send('Invalid order id');
    }

    const order = await billingOrder.findByIdForUser(orderId, req.user.id);
    if (!order) {
      return res.status(404).send('Billing order not found');
    }

    await billingService.processMoonpayWebhook({
      event: 'CREATED',
      webhookDeliveryIdempotencyKey: `mock_checkout_complete:${order.id}`,
      transactionObject: {
        id: order.providerChargeId || `mock_txn_${order.id}`,
        meta: {
          transactionStatus: 'SUCCESS',
          transactionSignature: `mock_sig_${order.id}`,
          customerDetails: {
            additionalJSON: JSON.stringify({
              billingOrderId: order.id,
              billingPlanKey: order.planKey,
            }),
          },
        },
      },
    });

    const redirectTarget = order?.metadata?.successRedirectUrl || config.billing.checkoutReturnUrl || `http://localhost:${config.port}`;
    const returnUrl = new URL(redirectTarget);
    returnUrl.searchParams.set('billing', 'success');
    returnUrl.searchParams.set('billingOrderId', String(order.id));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(getMockCheckoutSuccessHtml({
      order,
      redirectUrl: returnUrl.toString(),
    }));
  } catch (err) {
    console.error('Mock billing checkout completion error:', err);
    return res.status(500).send('Unable to complete mock checkout');
  }
});

router.get('/plans', async (req, res) => {
  try {
    res.json({
      enabled: Boolean(config.billing.enabled),
      provider: billingCatalog.PROVIDER,
      providerReady: billingCatalog.isMoonpayProviderReady(),
      providerMocked: billingCatalog.isMoonpayMockMode(),
      plans: billingCatalog.getPublicPlans(),
    });
  } catch (err) {
    console.error('Billing plans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/orders', authenticateAllowExpiredAccess, async (req, res) => {
  try {
    const state = await billingService.listBillingStateForUser(req.user.id);
    res.json({ orders: state.orders });
  } catch (err) {
    console.error('Billing orders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/state', authenticateAllowExpiredAccess, async (req, res) => {
  try {
    res.json(await billingService.listBillingStateForUser(req.user.id));
  } catch (err) {
    console.error('Billing state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/orders', authenticateAllowExpiredAccess, requireTrustedOrigin, async (req, res) => {
  try {
    const planKey = String(req.body?.planKey || '').trim();
    if (!planKey) {
      return res.status(400).json({ error: 'planKey is required' });
    }

    const order = await billingService.createOrderForUser(req.user, planKey);
    return res.status(201).json({
      message: 'Billing order created',
      order,
      checkoutUrl: order.providerCheckoutUrl,
    });
  } catch (err) {
    console.error('Billing order creation error:', err);
    const statusCode = Number(err?.statusCode) || 500;
    return res.status(statusCode).json({ error: err?.message || 'Internal server error' });
  }
});

router.post('/webhooks/moonpay', async (req, res) => {
  try {
    const authHeader = String(req.get('authorization') || '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const allowedTokens = new Set(config.billing.moonpay.webhookTokens);

    if (!bearerToken || !allowedTokens.has(bearerToken)) {
      return res.status(401).json({ error: 'Invalid MoonPay Commerce webhook token' });
    }

    const result = await billingService.processMoonpayWebhook(req.body || {});
    return res.json({
      message: result.duplicate ? 'Duplicate webhook ignored' : 'Webhook processed',
      duplicate: Boolean(result.duplicate),
      ignored: Boolean(result.ignored),
      rejected: Boolean(result.rejected),
      reason: result.reason || null,
    });
  } catch (err) {
    console.error('MoonPay Commerce webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.__private = {
  isLocalMockCheckoutRequest,
  requireLocalMockCheckout,
};
