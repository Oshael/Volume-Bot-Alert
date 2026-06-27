const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const helius = require('../src/services/helius');

describe('helius service', () => {
  it('builds the RPC url with the api key query param', () => {
    const url = helius.__private.buildRpcUrl({
      apiKey: 'test-key',
      baseUrl: 'https://mainnet.helius-rpc.com',
    });

    assert.equal(url, 'https://mainnet.helius-rpc.com/?api-key=test-key');
  });

  it('routes DAS methods to the das limiter bucket', () => {
    assert.equal(helius.__private.resolveMethodChannel('getAsset'), 'das');
    assert.equal(helius.__private.resolveMethodChannel('getTokenSupply'), 'rpc');
  });

  it('sends getAsset as a DAS JSON-RPC call', async () => {
    const calls = [];
    const client = helius.createHeliusClient({
      apiKey: 'test-key',
      requestImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(init.body),
        });
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', result: { id: 'asset-123' } }),
        };
      },
      rpcMinIntervalMs: 1,
      dasMinIntervalMs: 1,
      timeoutMs: 500,
    });

    const result = await client.getAsset('asset-123', {
      displayOptions: { showFungible: true },
    });

    assert.equal(result.id, 'asset-123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://mainnet.helius-rpc.com/?api-key=test-key');
    assert.equal(calls[0].body.method, 'getAsset');
    assert.deepEqual(calls[0].body.params, {
      id: 'asset-123',
      displayOptions: { showFungible: true },
    });
  });

  it('sends getTokenAccounts as a DAS JSON-RPC call with mint filters', async () => {
    const calls = [];
    const client = helius.createHeliusClient({
      apiKey: 'test-key',
      requestImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(init.body),
        });
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', result: { total: 321 } }),
        };
      },
      rpcMinIntervalMs: 1,
      dasMinIntervalMs: 1,
      timeoutMs: 500,
    });

    const result = await client.getTokenAccounts({
      mint: 'mint-123',
      page: 2,
      limit: 500,
    });

    assert.equal(result.total, 321);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://mainnet.helius-rpc.com/?api-key=test-key');
    assert.equal(calls[0].body.method, 'getTokenAccounts');
    assert.deepEqual(calls[0].body.params, {
      mint: 'mint-123',
      page: 2,
      limit: 500,
    });
  });

  it('sends token supply and largest accounts as standard RPC calls', async () => {
    const methods = [];
    const client = helius.createHeliusClient({
      apiKey: 'test-key',
      requestImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        methods.push(body.method);
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', result: { value: [] } }),
        };
      },
      rpcMinIntervalMs: 1,
      dasMinIntervalMs: 1,
      timeoutMs: 500,
    });

    await client.getTokenSupply('mint-1', { commitment: 'confirmed' });
    await client.getTokenLargestAccounts('mint-1');
    await client.getMultipleAccounts(['acc-1', 'acc-2'], { encoding: 'jsonParsed' });

    assert.deepEqual(methods, [
      'getTokenSupply',
      'getTokenLargestAccounts',
      'getMultipleAccounts',
    ]);
  });

  it('throws a structured error for RPC failures', async () => {
    const client = helius.createHeliusClient({
      apiKey: 'test-key',
      requestImpl: async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'rate limited',
          },
        }),
      }),
      rpcMinIntervalMs: 1,
      dasMinIntervalMs: 1,
      timeoutMs: 500,
    });

    await assert.rejects(
      client.getTokenSupply('mint-1'),
      (error) => error instanceof Error
        && error.code === -32000
        && error.method === 'getTokenSupply'
        && /rate limited/.test(error.message)
    );
  });

  it('updates a webhook through the Helius webhook API', async () => {
    const calls = [];
    const client = helius.createHeliusClient({
      apiKey: 'test-key',
      requestImpl: async (url, init) => {
        calls.push({
          url: String(url),
          method: init.method,
          body: JSON.parse(init.body),
        });
        return {
          ok: true,
          json: async () => ({ webhookID: 'webhook-1' }),
        };
      },
      timeoutMs: 500,
    });

    const result = await client.updateWebhook('webhook-1', {
      webhookURL: 'https://api.example.test/api/token-gate/webhooks/helius',
      transactionTypes: ['TRANSFER'],
      accountAddresses: ['Wallet111'],
      webhookType: 'enhanced',
      authHeader: 'Bearer secret',
    }, {
      apiBaseUrl: 'https://mainnet.helius-rpc.com',
    });

    assert.equal(result.webhookID, 'webhook-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://mainnet.helius-rpc.com/v0/webhooks/webhook-1?api-key=test-key');
    assert.equal(calls[0].method, 'PUT');
    assert.deepEqual(calls[0].body.accountAddresses, ['Wallet111']);
  });
});
