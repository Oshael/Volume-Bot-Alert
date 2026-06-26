const express = require('express');
const config = require('../../config');
const billingService = require('../services/billing-service');
const { requireTrustedOrigin } = require('../middleware/auth');
const { authenticatePreAccess, clearPreAccessCookie } = require('../services/pre-access-session');
const { serializeUser, clearAuthCookie, createAuthenticatedSession } = require('../services/auth-session');

const router = express.Router();

router.get('/me', authenticatePreAccess, async (req, res) => {
  res.json({
    user: serializeUser(req.user),
    access: req.access,
    returnUrl: config.preAccessCookie.returnUrl || null,
  });
});

router.get('/billing/state', authenticatePreAccess, async (req, res) => {
  try {
    res.json(await billingService.listBillingStateForUser(req.user.id));
  } catch (err) {
    console.error('Pre-access billing state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/billing/orders', authenticatePreAccess, requireTrustedOrigin, async (req, res) => {
  try {
    if (req.access.hasProductAccess) {
      return res.status(409).json({ error: 'Access is already active for this account' });
    }

    const planKey = String(req.body?.planKey || '').trim();
    if (!planKey) {
      return res.status(400).json({ error: 'planKey is required' });
    }

    const order = await billingService.createOrderForUser(req.user, planKey, {
      successRedirectUrl: config.preAccessCookie.returnUrl || null,
      metadata: {
        checkoutContext: 'pre_access',
      },
    });

    return res.status(201).json({
      message: 'Billing order created',
      order,
      checkoutUrl: order.providerCheckoutUrl,
    });
  } catch (err) {
    console.error('Pre-access billing order creation error:', err);
    const statusCode = Number(err?.statusCode) || 500;
    return res.status(statusCode).json({ error: err?.message || 'Internal server error' });
  }
});

router.post('/billing/orders/:orderId/sync', authenticatePreAccess, requireTrustedOrigin, async (req, res) => {
  try {
    const result = await billingService.syncOrderPaymentFromProvider(req.user, req.params.orderId);
    res.json({
      synced: Boolean(result.synced),
      reason: result.reason || null,
      order: result.order || null,
    });
  } catch (err) {
    console.error('Pre-access billing order sync error:', err);
    const statusCode = Number(err?.statusCode) || 500;
    return res.status(statusCode).json({ error: err?.message || 'Internal server error' });
  }
});

router.post('/complete', authenticatePreAccess, requireTrustedOrigin, async (req, res) => {
  try {
    if (!req.access.hasProductAccess) {
      return res.status(409).json({ error: 'Payment confirmation still pending' });
    }

    clearPreAccessCookie(res);
    clearAuthCookie(res);
    const payload = await createAuthenticatedSession({
      user: req.user,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      res,
    });

    res.json(payload);
  } catch (err) {
    console.error('Pre-access completion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', authenticatePreAccess, requireTrustedOrigin, async (req, res) => {
  clearPreAccessCookie(res);
  clearAuthCookie(res);
  res.json({ message: 'Pre-access flow closed' });
});

module.exports = router;
