const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodNativeBalanceProvider,
} = require('../src/services/robinhood-native-balance-provider');

const ALICE = `0x${'a'.repeat(40)}`;
const BOB = `0x${'b'.repeat(40)}`;

describe('Robinhood native balance provider', () => {
  it('reads one latest-state RPC batch and caches normalized balances', async () => {
    const calls = [];
    let now = 1000;
    const provider = createRobinhoodNativeBalanceProvider({
      now: () => now, cacheTtlMs: 30_000,
      rpcClient: { requestBatch: async (requests) => {
        calls.push(requests);
        return ['0xde0b6b3a7640000', '0x0'];
      } },
    });

    assert.deepEqual(await provider.readBalances([ALICE, BOB, ALICE]), {
      [ALICE]: '1000000000000000000', [BOB]: '0',
    });
    assert.deepEqual(calls[0], [
      { method: 'eth_getBalance', params: [ALICE, 'latest'] },
      { method: 'eth_getBalance', params: [BOB, 'latest'] },
    ]);
    now += 1000;
    assert.equal((await provider.readBalances([ALICE]))[ALICE], '1000000000000000000');
    assert.equal(calls.length, 1);
  });

  it('rejects invalid addresses, quantities and oversized pages', async () => {
    const provider = createRobinhoodNativeBalanceProvider({
      rpcClient: { requestBatch: async () => ['not-hex'] },
    });
    await assert.rejects(provider.readBalances([ALICE]), /invalid quantity/);
    await assert.rejects(provider.readBalances(['bad']), /20-byte address/);
    const addresses = Array.from({ length: 51 }, (_, index) => (
      `0x${index.toString(16).padStart(40, '0')}`
    ));
    await assert.rejects(provider.readBalances(addresses), /exceed 50/);
  });
});
