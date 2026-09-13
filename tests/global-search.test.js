process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeGlobalSearchRequest,
} = require('../src/services/global-search-contract');
const {
  createGlobalSearchReader,
  createRobinhoodGlobalSearchAdapter,
} = require('../src/services/global-search-reader');

const ADDRESS = `0x${'a'.repeat(40)}`;

function readyReadiness(status = 'ready') {
  return {
    async getWorkspaceChainReadiness() {
      return { robinhood: { status, capabilities: { monitored: status === 'ready' } } };
    },
  };
}

describe('global search contract', () => {
  it('classifies and normalizes an exact EVM address without accepting chain scope', () => {
    assert.deepEqual(normalizeGlobalSearchRequest({
      q: ADDRESS.toUpperCase(), kinds: 'token,wallet', limit: '5', chains: 'solana',
    }), {
      query: ADDRESS.toUpperCase(),
      classification: 'evm_address',
      normalizedAddress: ADDRESS,
      kinds: ['token', 'wallet'],
      limit: 5,
    });
  });

  it('bounds text, kind and result inputs', () => {
    assert.throws(() => normalizeGlobalSearchRequest({ q: 'x' }), /at least 2/);
    assert.throws(() => normalizeGlobalSearchRequest({ q: 'x'.repeat(121) }), /at most 120/);
    assert.throws(() => normalizeGlobalSearchRequest({ q: 'hood', kinds: 'pool' }), /unsupported result kind/);
    assert.throws(() => normalizeGlobalSearchRequest({ q: 'hood', limit: 21 }), /between 1 and 20/);
  });
});

describe('global exact-address search', () => {
  it('maps a canonical Robinhood catalog token to the expanded-chart destination', async () => {
    const adapter = createRobinhoodGlobalSearchAdapter({
      tokenCatalog: {
        async getByAddress(address, chain) {
          assert.equal(address, ADDRESS);
          assert.equal(chain, 'robinhood');
          return { address, symbol: 'HOOD', name: 'Robin Hood', last_image_url: 'https://example.test/hood.png' };
        },
      },
    });

    assert.deepEqual(await adapter.resolveExactToken({ address: ADDRESS }), [{
      kind: 'token', chain: 'robinhood', address: ADDRESS,
      symbol: 'HOOD', name: 'Robin Hood', imageUrl: 'https://example.test/hood.png',
      destination: { type: 'expanded-chart', chain: 'robinhood', address: ADDRESS },
      match: 'exact_address',
    }]);
  });

  it('searches every registered capable adapter and reports wallet availability explicitly', async () => {
    const calls = [];
    const adapter = {
      chain: 'robinhood',
      addressFamilies: ['evm_address'],
      async resolveExactToken(input) {
        calls.push(input);
        return [{
          kind: 'token', chain: 'robinhood', address: ADDRESS, symbol: 'HOOD',
          destination: { type: 'expanded-chart', chain: 'robinhood', address: ADDRESS },
          match: 'exact_address',
        }];
      },
    };
    const reader = createGlobalSearchReader({
      adapters: { robinhood: adapter },
      workspaceChainReadiness: readyReadiness(),
    });

    const result = await reader.search({
      q: ADDRESS, kinds: 'token,wallet', limit: 4, chains: 'solana',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].address, ADDRESS);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.chainStates, {
      robinhood: { kinds: { token: 'ready', wallet: 'unsupported' } },
    });
    assert.equal(result.count, 1);
    assert.equal(result.hits[0].address, ADDRESS);
  });

  it('returns explicit unsupported and syncing states without calling an adapter', async () => {
    let calls = 0;
    const adapter = {
      chain: 'robinhood', addressFamilies: ['evm_address'],
      async resolveExactToken() { calls += 1; return []; },
    };
    const syncing = createGlobalSearchReader({
      adapters: { robinhood: adapter }, workspaceChainReadiness: readyReadiness('syncing'),
    });
    const walletOnly = createGlobalSearchReader({
      adapters: { robinhood: adapter }, workspaceChainReadiness: readyReadiness(),
    });

    assert.equal((await syncing.search({ q: ADDRESS })).status, 'syncing');
    assert.equal((await walletOnly.search({ q: ADDRESS, kinds: 'wallet' })).status, 'unsupported');
    assert.equal(calls, 0);
  });

  it('bounds an adapter that ignores cancellation', async () => {
    const adapter = {
      chain: 'robinhood', addressFamilies: ['evm_address'],
      async resolveExactToken() { return new Promise(() => {}); },
    };
    const reader = createGlobalSearchReader({
      adapters: { robinhood: adapter },
      workspaceChainReadiness: readyReadiness(),
      timeoutMs: 5,
    });

    await assert.rejects(reader.search({ q: ADDRESS }), (error) => (
      error.status === 504 && /timed out/.test(error.message)
    ));
  });
});
