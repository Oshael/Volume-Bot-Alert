const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenGateWebhookSync = require('../src/services/token-gate-webhook-sync-service');

const gateConfig = {
  enabled: true,
  mintAddress: 'Mint11111111111111111111111111111111111111111',
  webhookTokens: ['webhook-secret'],
  heliusWebhook: {
    enabled: true,
    id: 'webhook-1',
    url: 'https://api.example.test/api/token-gate/webhooks/helius',
    apiBaseUrl: 'https://mainnet.helius-rpc.com',
    transactionTypes: ['TRANSFER'],
  },
};

describe('token gate webhook sync service', () => {
  it('builds an enhanced Helius webhook payload for linked wallets', () => {
    const payload = tokenGateWebhookSync.buildWebhookPayload(['Wallet111'], gateConfig);

    assert.deepEqual(payload, {
      webhookURL: 'https://api.example.test/api/token-gate/webhooks/helius',
      transactionTypes: ['TRANSFER'],
      accountAddresses: ['Wallet111'],
      webhookType: 'enhanced',
      authHeader: 'Bearer webhook-secret',
    });
  });

  it('syncs linked wallet addresses to an existing Helius webhook', async () => {
    const calls = [];
    const result = await tokenGateWebhookSync.syncLinkedWallets({
      config: gateConfig,
      userWalletModel: {
        listLinkedWalletAddresses: async () => ['Wallet222', 'Wallet111'],
      },
      heliusClient: {
        updateWebhook: async (webhookId, payload, options) => {
          calls.push({ webhookId, payload, options });
          return { webhookID: webhookId };
        },
      },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.walletCount, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].webhookId, 'webhook-1');
    assert.deepEqual(calls[0].payload.accountAddresses, ['Wallet222', 'Wallet111']);
    assert.equal(calls[0].options.apiBaseUrl, 'https://mainnet.helius-rpc.com');
  });

  it('skips sync when webhook config is incomplete', async () => {
    const result = await tokenGateWebhookSync.syncLinkedWallets({
      config: {
        ...gateConfig,
        heliusWebhook: { ...gateConfig.heliusWebhook, id: '' },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'helius_webhook_sync_disabled');
  });
});
