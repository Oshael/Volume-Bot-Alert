const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../config');

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }

  delete require.cache[CONFIG_PATH];
  try {
    return fn(require('../config'));
  } finally {
    delete require.cache[CONFIG_PATH];
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

describe('token gate config', () => {
  it('parses discount tiers from TOKEN_GATE_DISCOUNT_TIERS_JSON by highest threshold first', () => {
    withEnv({
      TOKEN_GATE_DISCOUNT_THRESHOLD: '1000000',
      TOKEN_GATE_DISCOUNT_PERCENT: '50',
      TOKEN_GATE_DISCOUNT_TIERS_JSON: JSON.stringify([
        { threshold: '250000', discountPercent: 10 },
        { threshold: '1000000', discountPercent: 50 },
        { threshold: '500000', discountPercent: 25 },
      ]),
    }, (config) => {
      assert.deepEqual(config.tokenGate.discountTiers, [
        { threshold: '1000000', discountPercent: 50, tier: 'discount_50' },
        { threshold: '500000', discountPercent: 25, tier: 'discount_25' },
        { threshold: '250000', discountPercent: 10, tier: 'discount_10' },
      ]);
    });
  });

  it('keeps the legacy single discount threshold when tier JSON is empty', () => {
    withEnv({
      TOKEN_GATE_DISCOUNT_THRESHOLD: '750000',
      TOKEN_GATE_DISCOUNT_PERCENT: '35',
      TOKEN_GATE_DISCOUNT_TIERS_JSON: '',
    }, (config) => {
      assert.deepEqual(config.tokenGate.discountTiers, [
        { threshold: '750000', discountPercent: 35, tier: 'discount_35' },
      ]);
    });
  });

  it('parses Helius webhook bearer tokens', () => {
    withEnv({
      HELIUS_WEBHOOK_TOKENS: ' token-a,token-b ,, ',
    }, (config) => {
      assert.deepEqual(config.tokenGate.webhookTokens, ['token-a', 'token-b']);
    });
  });

  it('parses Helius token gate webhook sync settings', () => {
    withEnv({
      HELIUS_TOKEN_GATE_WEBHOOK_SYNC_ENABLED: 'true',
      HELIUS_TOKEN_GATE_WEBHOOK_ID: 'webhook-1',
      HELIUS_TOKEN_GATE_WEBHOOK_URL: 'https://api.example.test/api/token-gate/webhooks/helius',
      HELIUS_TOKEN_GATE_WEBHOOK_TRANSACTION_TYPES: 'TRANSFER,SWAP',
      HELIUS_WEBHOOK_API_BASE_URL: 'https://mainnet.helius-rpc.com',
    }, (config) => {
      assert.equal(config.tokenGate.heliusWebhook.enabled, true);
      assert.equal(config.tokenGate.heliusWebhook.id, 'webhook-1');
      assert.equal(config.tokenGate.heliusWebhook.url, 'https://api.example.test/api/token-gate/webhooks/helius');
      assert.deepEqual(config.tokenGate.heliusWebhook.transactionTypes, ['TRANSFER', 'SWAP']);
      assert.equal(config.tokenGate.heliusWebhook.apiBaseUrl, 'https://mainnet.helius-rpc.com');
    });
  });
});
