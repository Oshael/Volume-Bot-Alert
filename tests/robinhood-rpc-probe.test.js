const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONTRACTS,
  buildLogRange,
  maskEndpoint,
  parseBlockSelector,
  resolveLogRange,
  rpcRequest,
  runProviderProbe,
} = require('../src/utils/robinhood-rpc-probe');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe('robinhood RPC probe', () => {
  it('masks endpoint credentials, API keys, query strings, and fragments', () => {
    const masked = maskEndpoint('https://user:pass@robinhood-mainnet.g.alchemy.com/v2/super-secret-key?token=also-secret#private');

    assert.equal(masked, 'https://robinhood-mainnet.g.alchemy.com/v2/***');
    assert.equal(masked.includes('super-secret-key'), false);
    assert.equal(masked.includes('also-secret'), false);
    assert.equal(masked.includes('user'), false);
  });

  it('builds an inclusive bounded log range without going below genesis', () => {
    assert.deepEqual(buildLogRange(100n, 4), { fromBlock: '0x61', toBlock: '0x64' });
    assert.deepEqual(buildLogRange(2n, 10), { fromBlock: '0x0', toBlock: '0x2' });
    assert.equal(parseBlockSelector('6880646'), 6880646n);
    assert.equal(parseBlockSelector('0x68fc06'), 6880262n);
    assert.deepEqual(resolveLogRange(7000000n, { logBlock: '6880646' }), {
      fromBlock: '0x68fd86',
      toBlock: '0x68fd86',
    });
  });

  it('probes the expected Robinhood chain, contracts, and log targets', async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      let result = null;

      if (request.method === 'eth_chainId') result = '0x1237';
      if (request.method === 'eth_blockNumber') result = '0x64';
      if (request.method === 'eth_getBlockByNumber') result = { timestamp: '0x10' };
      if (request.method === 'eth_getCode') result = '0x6000';
      if (request.method === 'eth_getLogs') {
        result = [{ blockNumber: '0x63', topics: ['0xabc'] }];
      }

      return jsonResponse({ jsonrpc: '2.0', id: request.id, result });
    };

    const report = await runProviderProbe(
      { label: 'test', url: 'https://rpc.example.test/v2/secret' },
      { fetchImpl, logBlockRange: 4 }
    );

    assert.equal(report.ok, true);
    assert.equal(report.complete, true);
    assert.equal(report.chainId, 4663);
    assert.equal(report.headBlock, '100');
    assert.equal(report.blockTimestamp, '16');
    assert.equal(report.contracts.length, CONTRACTS.length);
    assert.equal(report.contracts.every((item) => item.codeBytes === 2), true);
    assert.equal(report.logs.length, CONTRACTS.filter((item) => item.logs).length);
    assert.equal(report.logs.every((item) => item.fromBlock === '0x61' && item.toBlock === '0x64'), true);
    assert.equal(report.logs.every((item) => item.topic0s[0] === '0xabc'), true);
    assert.equal(report.endpoint, 'https://rpc.example.test/v2/***');
    assert.equal(report.totals.requests, calls.length);
    assert.equal(report.totals.errors, 0);
  });

  it('rejects a healthy endpoint connected to the wrong chain', async () => {
    const report = await runProviderProbe(
      { label: 'wrong-chain', url: 'https://rpc.example.test/key' },
      {
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(init.body);
          return jsonResponse({ jsonrpc: '2.0', id: request.id, result: '0x1' });
        },
      }
    );

    assert.equal(report.ok, false);
    assert.equal(report.complete, false);
    assert.equal(report.chainId, 1);
    assert.equal(report.totals.requests, 1);
    assert.match(report.errors[0].message, /expected 4663/);
  });

  it('preserves HTTP failure metrics and does not echo transport secrets', async () => {
    await assert.rejects(
      () => rpcRequest('https://rpc.example.test/secret-key', 'eth_chainId', [], {
        fetchImpl: async () => jsonResponse({ message: 'limited' }, 429),
      }),
      (error) => {
        assert.match(error.message, /HTTP 429/);
        assert.equal(error.message.includes('secret-key'), false);
        assert.equal(error.probeMetrics.httpStatus, 429);
        assert.equal(error.probeMetrics.responseBytes > 0, true);
        return true;
      }
    );

    await assert.rejects(
      () => rpcRequest('https://rpc.example.test/secret-key', 'eth_chainId', [], {
        fetchImpl: async () => {
          throw new Error('failed while requesting https://rpc.example.test/secret-key');
        },
      }),
      (error) => {
        assert.equal(error.message, 'eth_chainId transport failed (Error)');
        assert.equal(error.message.includes('secret-key'), false);
        return true;
      }
    );
  });
});
