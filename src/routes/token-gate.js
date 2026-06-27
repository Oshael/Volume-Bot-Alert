const express = require('express');
const config = require('../../config');
const tokenGateWebhookService = require('../services/token-gate-webhook-service');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = String(req.get('authorization') || '');
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

async function handleHeliusWebhook(req, res) {
  try {
    const allowedTokens = new Set(config.tokenGate.webhookTokens || []);
    const bearerToken = getBearerToken(req);
    if (!bearerToken || !allowedTokens.has(bearerToken)) {
      return res.status(401).json({ error: 'Invalid Helius webhook token' });
    }

    const result = await tokenGateWebhookService.processHeliusTokenWebhook(req.body || {});
    return res.json({
      message: result.ignored ? 'Webhook ignored' : 'Webhook processed',
      ignored: Boolean(result.ignored),
      reason: result.reason || null,
      affectedWalletCount: result.affectedWalletCount || 0,
      refreshedWalletCount: result.refreshedWalletCount || 0,
      revokedUserCount: result.revokedUserCount || 0,
    });
  } catch (err) {
    console.error('Helius token gate webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/webhooks/helius', handleHeliusWebhook);

module.exports = router;
module.exports.__private = {
  getBearerToken,
  handleHeliusWebhook,
};
