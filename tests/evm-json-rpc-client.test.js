const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  EvmRpcError,
  createEvmJsonRpcClient,
  parseRetryAfterMs,
} = require('../src/services/evm-json-rpc-client');

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function requestFrom(init) {
  return JSON.parse(init.body);
}

describe('provider-agnostic EVM JSON-RPC client', () => {
  it('uses monotonic IDs and returns JSON-RPC results', async () => {
    const ids = [];
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      fetchImpl: async (_url, init) => {
        const request = requestFrom(init);
        ids.push(request.id);
        return response({ jsonrpc: '2.0', id: request.id, result: request.method });
      },
    });

    assert.equal(await client.request('eth_chainId'), 'eth_chainId');
    assert.equal(await client.request('eth_blockNumber'), 'eth_blockNumber');
    assert.deepEqual(ids, [1, 2]);
  });

  it('resolves out-of-order JSON-RPC batch responses in request order', async () => {
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      fetchImpl: async (_url, init) => {
        const requests = requestFrom(init);
        return response([...requests].reverse().map((request) => ({
          jsonrpc: '2.0', id: request.id, result: request.params[0],
        })));
      },
    });

    const result = await client.requestBatch(['0x1', '0x2', '0x3'].map((blockNumber) => ({
      method: 'eth_getBlockByNumber', params: [blockNumber, false],
    })));

    assert.deepEqual(result, ['0x1', '0x2', '0x3']);
    const metrics = client.getMetrics().public['eth_getBlockByNumber:batch'];
    assert.equal(metrics.requests, 1);
    assert.equal(metrics.batchItems, 3);
  });

  it('falls back atomically when one batch item is rate limited', async () => {
    const calls = [];
    const client = createEvmJsonRpcClient({
      providers: [
        { name: 'public', url: 'https://public.example.test' },
        { name: 'fallback', url: 'https://fallback.example.test' },
      ],
      maxRetries: 0,
      fetchImpl: async (url, init) => {
        const requests = requestFrom(init);
        calls.push(url);
        return response(requests.map((request, index) => (
          url.includes('public') && index === 1
            ? { jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'limited' } }
            : { jsonrpc: '2.0', id: request.id, result: request.params[0] }
        )));
      },
    });

    const result = await client.requestBatch(['0x1', '0x2'].map((blockNumber) => ({
      method: 'eth_getBlockByNumber', params: [blockNumber, false],
    })));

    assert.deepEqual(result, ['0x1', '0x2']);
    assert.deepEqual(calls, ['https://public.example.test/', 'https://fallback.example.test/']);
    assert.equal(client.getMetrics().fallback['eth_getBlockByNumber:batch'].fallbacks, 1);
  });

  it('reports a non-batch response as unsupported', async () => {
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      fetchImpl: async () => response({ jsonrpc: '2.0', id: 1, result: null }),
    });

    await assert.rejects(
      client.requestBatch([{ method: 'eth_getBlockByNumber', params: ['0x1', false] }]),
      { code: 'batch_unsupported' }
    );
  });

  it('retries transient failures with Retry-After and records 429 metrics', async () => {
    const delays = [];
    let calls = 0;
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test/private-key' }],
      maxRetries: 1,
      sleep: async (delay) => delays.push(delay),
      fetchImpl: async (_url, init) => {
        calls += 1;
        const request = requestFrom(init);
        if (calls === 1) return response({}, 429, { 'retry-after': '2' });
        return response({ jsonrpc: '2.0', id: request.id, result: '0x1237' });
      },
    });

    assert.equal(await client.request('eth_chainId'), '0x1237');
    assert.deepEqual(delays, [2000]);
    assert.deepEqual(client.getMetrics().public.eth_chainId.statuses, {
      '2xx': 1, '4xx': 0, '5xx': 0, '429': 1, transport: 0,
    });
    assert.equal(client.getMetrics().public.eth_chainId.retries, 1);
  });

  it('falls back after primary retries are exhausted without changing the request ID', async () => {
    const calls = [];
    const delays = [];
    const client = createEvmJsonRpcClient({
      providers: [
        { name: 'robinhood-public', url: 'https://public.example.test' },
        { name: 'alchemy-free', url: 'https://alchemy.example.test/v2/secret' },
      ],
      maxRetries: 2,
      baseBackoffMs: 100,
      random: () => 0.5,
      sleep: async (delay) => delays.push(delay),
      fetchImpl: async (url, init) => {
        const request = requestFrom(init);
        calls.push({ url, id: request.id });
        if (url.includes('public')) return response({}, 503);
        return response({ jsonrpc: '2.0', id: request.id, result: '0x99' });
      },
    });

    assert.equal(await client.request('eth_blockNumber'), '0x99');
    assert.deepEqual(calls.map(({ id }) => id), [1, 1, 1, 1]);
    assert.deepEqual(delays, [100, 200]);
    const metrics = client.getMetrics();
    assert.equal(metrics['robinhood-public'].eth_blockNumber.requests, 3);
    assert.equal(metrics['robinhood-public'].eth_blockNumber.retries, 2);
    assert.equal(metrics['alchemy-free'].eth_blockNumber.fallbacks, 1);
    assert.equal(metrics['alchemy-free'].eth_blockNumber.successes, 1);
  });

  it('can validate one named provider without silently falling back to another', async () => {
    const calls = [];
    const client = createEvmJsonRpcClient({
      providers: [
        { name: 'robinhood-public', url: 'https://public.example.test' },
        { name: 'alchemy-free', url: 'https://alchemy.example.test' },
      ],
      maxRetries: 0,
      fetchImpl: async (url, init) => {
        calls.push(url);
        const request = requestFrom(init);
        return response({
          jsonrpc: '2.0',
          id: request.id,
          result: url.includes('alchemy') ? '0x1' : '0x1237',
        });
      },
    });

    assert.equal(await client.requestProvider('robinhood-public', 'eth_chainId'), '0x1237');
    assert.equal(await client.requestProvider('alchemy-free', 'eth_chainId'), '0x1');
    assert.deepEqual(calls, ['https://public.example.test/', 'https://alchemy.example.test/']);
    assert.equal(client.getMetrics()['alchemy-free'].eth_chainId.fallbacks, 0);
    assert.throws(() => client.requestProvider('missing', 'eth_chainId'), /Unknown EVM RPC provider/);
  });

  it('allows explicit provider fallback for historical-state RPC errors', async () => {
    const calls = [];
    const client = createEvmJsonRpcClient({
      providers: [
        { name: 'robinhood-public', url: 'https://public.example.test' },
        { name: 'alchemy-free', url: 'https://alchemy.example.test' },
      ],
      maxRetries: 0,
      fetchImpl: async (url, init) => {
        calls.push(url);
        const request = requestFrom(init);
        return url.includes('public')
          ? response({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'state unavailable' } })
          : response({ jsonrpc: '2.0', id: request.id, result: '0x1234' });
      },
    });

    assert.equal(
      await client.request('eth_getCode', ['0x1', '0x2'], { fallbackOnRpcError: true }),
      '0x1234'
    );
    assert.deepEqual(calls, ['https://public.example.test/', 'https://alchemy.example.test/']);
    assert.equal(client.getMetrics()['alchemy-free'].eth_getCode.fallbacks, 1);
  });

  it('classifies only recognized eth_getLogs -32000 range failures for adaptive polling', async () => {
    const messages = ['log query timed out', 'execution reverted'];
    let calls = 0;
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      maxRetries: 2,
      fetchImpl: async (_url, init) => {
        const request = requestFrom(init);
        const message = messages[calls];
        calls += 1;
        return response({
          jsonrpc: '2.0', id: request.id, error: { code: -32000, message },
        });
      },
    });

    await assert.rejects(client.request('eth_getLogs', [{}]), (error) => {
      assert.equal(error.code, 'log_range_error');
      assert.equal(error.rpcCode, -32000);
      assert.equal(error.retryable, false);
      return true;
    });
    await assert.rejects(client.request('eth_getLogs', [{}]), (error) => {
      assert.equal(error.code, 'rpc_error');
      assert.equal(error.rpcCode, -32000);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 2);
    assert.deepEqual(client.getMetrics().public.eth_getLogs.errorCodes, {
      log_range_error: 1,
      rpc_error: 1,
    });
  });

  it('normalizes timeout and transport errors without exposing provider URLs', async () => {
    let abortSignal;
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test/super-secret-key' }],
      timeoutMs: 5,
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        abortSignal = init.signal;
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('secret transport failure')));
        });
      },
    });

    await assert.rejects(client.request('eth_getLogs'), (error) => {
      assert.equal(error instanceof EvmRpcError, true);
      assert.equal(error.code, 'timeout');
      assert.equal(error.retryable, true);
      assert.equal(error.provider, 'public');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
    assert.equal(abortSignal.aborted, true);
    assert.equal(client.getMetrics().public.eth_getLogs.errorCodes.timeout, 1);
  });

  it('does not retry invalid requests or non-transient RPC errors', async () => {
    let calls = 0;
    const client = createEvmJsonRpcClient({
      providers: [
        { name: 'public', url: 'https://public.example.test' },
        { name: 'fallback', url: 'https://fallback.example.test' },
      ],
      maxRetries: 2,
      fetchImpl: async (_url, init) => {
        calls += 1;
        const request = requestFrom(init);
        return response({
          jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' },
        });
      },
    });

    await assert.rejects(client.request('eth_getLogs', [{}]), (error) => {
      assert.equal(error.code, 'rpc_error');
      assert.equal(error.rpcCode, -32602);
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes('Invalid params'), false);
      return true;
    });
    assert.equal(calls, 1);
  });

  it('rejects mismatched response IDs and respects caller aborts', async () => {
    const mismatched = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      fetchImpl: async () => response({ jsonrpc: '2.0', id: 999, result: 'wrong' }),
    });
    await assert.rejects(mismatched.request('eth_chainId'), { code: 'invalid_response' });

    const controller = new AbortController();
    controller.abort();
    const aborted = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      fetchImpl: async (_url, init) => {
        if (init.signal.aborted) throw new Error('aborted');
        return response({});
      },
    });
    await assert.rejects(aborted.request('eth_chainId', [], { signal: controller.signal }), (error) => {
      assert.equal(error.code, 'aborted');
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it('keeps latency samples bounded and exposes p50/p95/p99 per provider and method', async () => {
    let currentTime = 0;
    const client = createEvmJsonRpcClient({
      providers: [{ name: 'public', url: 'https://rpc.example.test' }],
      now: () => currentTime,
      fetchImpl: async (_url, init) => {
        const request = requestFrom(init);
        currentTime += request.id;
        return response({ jsonrpc: '2.0', id: request.id, result: null });
      },
    });

    for (let index = 0; index < 300; index += 1) await client.request('eth_call');
    const latency = client.getMetrics().public.eth_call.latencyMs;
    assert.equal(latency.count, 256);
    assert.equal(latency.p50, 172);
    assert.equal(latency.p95, 288);
    assert.equal(latency.p99, 298);
  });

  it('parses numeric and HTTP-date Retry-After values', () => {
    assert.equal(parseRetryAfterMs('1.5', 0), 1500);
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
    assert.equal(parseRetryAfterMs('invalid', 0), null);
  });
});
