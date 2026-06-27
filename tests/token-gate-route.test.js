const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const tokenGateWebhookService = require('../src/services/token-gate-webhook-service');
const tokenGateRoutes = require('../src/routes/token-gate');

const originalTokens = config.tokenGate.webhookTokens;
const originalProcess = tokenGateWebhookService.processHeliusTokenWebhook;

function createReq({ authorization, body } = {}) {
  return {
    body,
    get(name) {
      return String(name).toLowerCase() === 'authorization' ? authorization : '';
    },
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('token gate webhook route', () => {
  afterEach(() => {
    config.tokenGate.webhookTokens = originalTokens;
    tokenGateWebhookService.processHeliusTokenWebhook = originalProcess;
  });

  it('rejects Helius webhook calls without a valid bearer token', async () => {
    config.tokenGate.webhookTokens = ['secret-token'];
    tokenGateWebhookService.processHeliusTokenWebhook = async () => {
      throw new Error('should not process unauthorized webhook');
    };

    const res = createRes();
    await tokenGateRoutes.__private.handleHeliusWebhook(createReq({
      authorization: 'Bearer wrong-token',
      body: {},
    }), res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Invalid Helius webhook token');
  });

  it('processes Helius webhook calls with a configured bearer token', async () => {
    config.tokenGate.webhookTokens = ['secret-token'];
    const payloads = [];
    tokenGateWebhookService.processHeliusTokenWebhook = async (payload) => {
      payloads.push(payload);
      return {
        ignored: false,
        affectedWalletCount: 1,
        refreshedWalletCount: 1,
        revokedUserCount: 0,
      };
    };

    const res = createRes();
    await tokenGateRoutes.__private.handleHeliusWebhook(createReq({
      authorization: 'Bearer secret-token',
      body: { tokenTransfers: [{ mint: 'Mint111' }] },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Webhook processed');
    assert.equal(res.body.affectedWalletCount, 1);
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0], { tokenTransfers: [{ mint: 'Mint111' }] });
  });
});
