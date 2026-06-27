const config = require('../../config');
const userWallet = require('../models/user-wallet');
const helius = require('./helius');

function getWebhookAuthHeader(gateConfig = config.tokenGate || {}) {
  const [token] = gateConfig.webhookTokens || [];
  return token ? `Bearer ${token}` : null;
}

function buildWebhookPayload(walletAddresses = [], gateConfig = config.tokenGate || {}) {
  const webhookConfig = gateConfig.heliusWebhook || {};
  const payload = {
    webhookURL: webhookConfig.url,
    transactionTypes: webhookConfig.transactionTypes || ['TRANSFER'],
    accountAddresses: walletAddresses,
    webhookType: 'enhanced',
  };
  const authHeader = getWebhookAuthHeader(gateConfig);
  if (authHeader) {
    payload.authHeader = authHeader;
  }
  return payload;
}

function canSyncWebhook(gateConfig = config.tokenGate || {}) {
  const webhookConfig = gateConfig.heliusWebhook || {};
  return Boolean(
    gateConfig.enabled
    && gateConfig.mintAddress
    && webhookConfig.enabled
    && webhookConfig.id
    && webhookConfig.url
    && (gateConfig.webhookTokens || []).length > 0
  );
}

async function syncLinkedWallets(options = {}) {
  const gateConfig = options.config || config.tokenGate || {};
  if (!canSyncWebhook(gateConfig)) {
    return {
      skipped: true,
      reason: 'helius_webhook_sync_disabled',
      walletCount: 0,
    };
  }

  const walletModel = options.userWalletModel || userWallet;
  const heliusClient = options.heliusClient || helius;
  const webhookConfig = gateConfig.heliusWebhook || {};
  const walletAddresses = await walletModel.listLinkedWalletAddresses();
  const payload = buildWebhookPayload(walletAddresses, gateConfig);

  await heliusClient.updateWebhook(webhookConfig.id, payload, {
    apiBaseUrl: webhookConfig.apiBaseUrl,
  });

  return {
    skipped: false,
    reason: null,
    walletCount: walletAddresses.length,
  };
}

function queueLinkedWalletSync(options = {}) {
  void syncLinkedWallets(options).catch((err) => {
    console.warn('Helius token gate webhook sync failed:', err.message);
  });
}

module.exports = {
  buildWebhookPayload,
  canSyncWebhook,
  queueLinkedWalletSync,
  syncLinkedWallets,
};
