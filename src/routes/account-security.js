const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const { authenticateAllowExpiredAccess, requireTrustedOrigin } = require('../middleware/auth');
const { authenticatePreAccess, isHardBlockedAccess } = require('../services/pre-access-session');
const billingOrder = require('../models/billing-order');
const User = require('../models/user');
const UserSocialIdentity = require('../models/user-social-identity');
const { buildIdentitySnapshot } = require('../services/social-auth');

const router = express.Router();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBillingAmount(currencyCode, amountMinor) {
  const normalizedCode = String(currencyCode || '').trim().toUpperCase() || 'USD';
  const amount = Number(amountMinor);
  return `${normalizedCode} ${Number.isFinite(amount) ? (amount / 100).toFixed(2) : '0.00'}`;
}

function formatDateTime(value) {
  if (!value) {
    return 'Not available';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function getReceiptField(label, value) {
  if (!value) {
    return '';
  }

  return `
    <div class="receipt-row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderBillingReceiptHtml(order, user) {
  const metadata = order?.metadata && typeof order.metadata === 'object' ? order.metadata : {};
  const providerLabel = order?.provider === 'moonpay_commerce' ? 'MoonPay Commerce' : String(order?.provider || 'Unknown provider');
  const paidAt = formatDateTime(order?.paidAt);
  const createdAt = formatDateTime(order?.createdAt);
  const amount = formatBillingAmount(order?.currencyCode, order?.currencyAmountMinor);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TrendScope Payment Receipt</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        background: #07111d;
        color: #e9f1ff;
        font-family: Arial, sans-serif;
      }
      main {
        max-width: 760px;
        margin: 42px auto;
        padding: 32px;
        background: #0f1b2b;
        border: 1px solid #214064;
        border-radius: 20px;
      }
      .topline {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        margin-bottom: 28px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 32px;
      }
      p {
        margin: 0;
        color: #b8c9e2;
        line-height: 1.6;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(0, 245, 140, 0.38);
        background: rgba(5, 26, 18, 0.92);
        color: #b1ffd8;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
        margin-bottom: 28px;
      }
      .summary-card, .details {
        border: 1px solid #214064;
        border-radius: 16px;
        background: rgba(6, 11, 18, 0.78);
      }
      .summary-card {
        padding: 18px 20px;
      }
      .summary-card span {
        display: block;
        color: #8ca4c5;
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        margin-bottom: 8px;
      }
      .summary-card strong {
        display: block;
        font-size: 26px;
        line-height: 1.1;
      }
      .details {
        padding: 8px 0;
      }
      .receipt-row {
        display: grid;
        grid-template-columns: 180px 1fr;
        gap: 16px;
        padding: 14px 20px;
        border-top: 1px solid rgba(33, 64, 100, 0.72);
      }
      .receipt-row:first-child {
        border-top: 0;
      }
      dt {
        margin: 0;
        color: #8ca4c5;
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      dd {
        margin: 0;
        color: #eef4ff;
        font-size: 15px;
        font-weight: 700;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="topline">
        <div>
          <h1>TrendScope Payment Receipt</h1>
          <p>Internal payment confirmation for the account-linked billing order.</p>
        </div>
        <span class="badge">${escapeHtml(String(order?.status || 'paid').toUpperCase())}</span>
      </div>
      <section class="summary">
        <div class="summary-card">
          <span>Plan</span>
          <strong>${escapeHtml(order?.planName || 'Unknown plan')}</strong>
        </div>
        <div class="summary-card">
          <span>Amount</span>
          <strong>${escapeHtml(amount)}</strong>
        </div>
      </section>
      <section class="details">
        ${getReceiptField('Receipt ID', `TS-${order.id}`)}
        ${getReceiptField('Account', user?.email || user?.username || null)}
        ${getReceiptField('Provider', providerLabel)}
        ${getReceiptField('Access days', order?.accessDays ? String(order.accessDays) : null)}
        ${getReceiptField('Paid at', paidAt)}
        ${getReceiptField('Order created', createdAt)}
        ${getReceiptField('Provider charge ID', order?.providerChargeId || null)}
        ${getReceiptField('Provider status', order?.providerStatus || null)}
        ${getReceiptField('Transaction ID', metadata.providerTransactionId || null)}
        ${getReceiptField('Transaction signature', metadata.providerTransactionSignature || null)}
      </section>
    </main>
  </body>
</html>`;
}

function rejectHardBlockedAccess(req, res, next) {
  if (isHardBlockedAccess(req.access)) {
    return res.status(403).json({ error: req.access?.denialReason || 'Access revoked' });
  }
  return next();
}

function authenticateAccountSecurity(req, res, next) {
  const bearerToken = String(req.get('authorization') || '').startsWith('Bearer ')
    ? String(req.get('authorization')).slice(7).trim()
    : '';
  const decodedBearer = bearerToken ? jwt.decode(bearerToken) : null;
  const hasAuthCookie = Boolean(req.cookies?.[config.authCookie.name]);
  const hasPreAccessCookie = Boolean(req.cookies?.[config.preAccessCookie.name]);
  const hasPreAccessBearer = Boolean(bearerToken && decodedBearer?.type === 'pre_access');
  const hasAuthBearer = Boolean(bearerToken && !hasPreAccessBearer);

  if (hasAuthCookie || hasAuthBearer) {
    return authenticateAllowExpiredAccess(req, res, () => rejectHardBlockedAccess(req, res, next));
  }

  if (hasPreAccessCookie || hasPreAccessBearer) {
    return authenticatePreAccess(req, res, () => rejectHardBlockedAccess(req, res, next));
  }

  return res.status(401).json({ error: 'Account security authentication required' });
}

router.get('/identities', authenticateAccountSecurity, async (req, res) => {
  try {
    const identities = await UserSocialIdentity.listByUserId(req.user.id);
    res.json({
      providers: buildIdentitySnapshot(identities),
      scope: req.preAccessToken ? 'pre_access' : 'authenticated',
    });
  } catch (err) {
    console.error('Account security identities error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/identities/:provider/unlink', authenticateAccountSecurity, requireTrustedOrigin, async (req, res) => {
  try {
    const provider = UserSocialIdentity.normalizeProvider(req.params.provider);
    const currentPassword = String(req.body?.currentPassword || '');

    if (!provider) {
      return res.status(400).json({ error: 'Unsupported social provider' });
    }

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required' });
    }

    const userWithPassword = await User.findByEmail(req.user.email);
    if (!userWithPassword?.password_hash) {
      return res.status(401).json({ error: 'Account password is unavailable for confirmation' });
    }

    const passwordValid = await User.verifyPassword(currentPassword, userWithPassword.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const existingIdentity = await UserSocialIdentity.findByUserAndProvider(req.user.id, provider);
    if (!existingIdentity) {
      return res.status(404).json({ error: 'This social identity is not linked to the current account' });
    }

    await UserSocialIdentity.removeLinkForUser(req.user.id, provider);
    const identities = await UserSocialIdentity.listByUserId(req.user.id);

    return res.json({
      message: `${provider === 'google' ? 'Google' : 'Discord'} identity unlinked successfully`,
      providers: buildIdentitySnapshot(identities),
      scope: req.preAccessToken ? 'pre_access' : 'authenticated',
    });
  } catch (err) {
    console.error('Account security unlink error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/billing/orders/:orderId/receipt', authenticateAccountSecurity, async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).send('Invalid billing order id');
    }

    const order = await billingOrder.findByIdForUser(orderId, req.user.id);
    if (!order) {
      return res.status(404).send('Billing order not found');
    }

    if (order.status !== 'paid') {
      return res.status(409).send('Receipt is available only after payment confirmation');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(renderBillingReceiptHtml(order, req.user));
  } catch (err) {
    console.error('Account security receipt error:', err);
    return res.status(500).send('Internal server error');
  }
});

module.exports = router;
