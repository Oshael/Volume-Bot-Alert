const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  TRANSFER_TOPIC,
  ZERO_TOPIC,
  createErc20SupplyDeltaReader,
} = require('../src/services/evm-erc20-supply-delta');

const TOKEN = '0x1111111111111111111111111111111111111111';
const HOLDER = `0x${'0'.repeat(24)}${'2'.repeat(40)}`;

function transfer(index, from, to, amount) {
  return {
    transactionHash: `0x${String(index).padStart(64, '0')}`,
    logIndex: `0x${index.toString(16)}`,
    topics: [TRANSFER_TOPIC, from, to],
    data: `0x${BigInt(amount).toString(16).padStart(64, '0')}`,
  };
}

describe('ERC-20 supply delta reader', () => {
  it('nets mint and burn logs without double-counting zero-to-zero transfers', async () => {
    const mint = transfer(1, ZERO_TOPIC, HOLDER, 100);
    const burn = transfer(2, HOLDER, ZERO_TOPIC, 25);
    const zeroToZero = transfer(3, ZERO_TOPIC, ZERO_TOPIC, 9);
    const calls = [];
    const reader = createErc20SupplyDeltaReader({
      rpcClient: {
        async request(method, params) {
          calls.push({ method, filter: params[0] });
          return params[0].topics[1] === ZERO_TOPIC
            ? [mint, zeroToZero]
            : [burn, zeroToZero];
        },
      },
    });

    const result = await reader.getDelta(TOKEN, { fromBlock: '0x10', toBlock: '0x20' });

    assert.deepEqual(result, { usable: true, deltaRaw: '75', events: 3 });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === 'eth_getLogs'));
  });

  it('splits adaptive provider range failures and reports malformed evidence unavailable', async () => {
    const ranges = [];
    const reader = createErc20SupplyDeltaReader({
      rpcClient: {
        async request(_method, params) {
          const filter = params[0];
          ranges.push([filter.fromBlock, filter.toBlock]);
          if (filter.fromBlock === '0x1' && filter.toBlock === '0x4') {
            const error = new Error('payload too large');
            error.code = 'http_error';
            error.httpStatus = 413;
            throw error;
          }
          return filter.topics[1] === ZERO_TOPIC
            ? [{ ...transfer(1, ZERO_TOPIC, HOLDER, 1), data: '0xbroken' }]
            : [];
        },
      },
    });

    const result = await reader.getDelta(TOKEN, { fromBlock: 1, toBlock: 4 });

    assert.equal(result.usable, false);
    assert.ok(ranges.some((range) => range[1] === '0x2'));
    assert.ok(ranges.some((range) => range[0] === '0x3'));
  });
});
