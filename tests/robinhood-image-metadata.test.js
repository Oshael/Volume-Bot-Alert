const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  BANKR_TOKEN_FEES_URL,
  PONS_LOGO_SELECTOR,
  STOCK_ASSETS_URL,
  TOKEN_URI_SELECTOR,
  createRobinhoodImageMetadataResolver,
} = require('../src/services/robinhood-image-metadata');

const TOKEN = `0x${'1'.repeat(40)}`;

function encodeText(value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const word = (number) => number.toString(16).padStart(64, '0');
  return `0x${word(32)}${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() { return JSON.stringify(payload); },
  };
}

function harness(input = {}) {
  const calls = [];
  const rpcClient = {
    async request(method, params) {
      assert.equal(method, 'eth_call');
      const selector = params[0].data;
      assert.ok([PONS_LOGO_SELECTOR, TOKEN_URI_SELECTOR].includes(selector));
      calls.push(selector === PONS_LOGO_SELECTOR ? 'pons' : 'tokenURI');
      const value = selector === PONS_LOGO_SELECTOR ? input.pons : input.tokenUri;
      return value ? encodeText(value) : '0x';
    },
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === STOCK_ASSETS_URL) {
      calls.push('stock');
      return jsonResponse({
        assets: input.stock ? [{
          logoUrl: input.stock,
          deployments: [{ chainId: 4663, contractAddress: TOKEN }],
        }] : [],
      });
    }
    if (href.startsWith(BANKR_TOKEN_FEES_URL)) {
      calls.push('bankr');
      return jsonResponse({
        chain: 'robinhood',
        tokens: input.bankrVerified ? [{ tokenAddress: TOKEN, source: 'doppler' }] : [],
      });
    }
    calls.push('ipfs');
    return jsonResponse(input.ipfsMetadata || {});
  };
  const blockscoutClient = {
    async getTokenMetadata(address) {
      calls.push('blockscout');
      if (input.blockscoutError) throw new Error('Blockscout unavailable');
      return {
        address, available: true, symbol: 'TKN', name: 'Token',
        imageUrl: input.blockscout || null,
      };
    },
    async getContractCreator() {
      calls.push('creator');
      return input.creator || null;
    },
  };
  const dexClient = {
    async getTokenPairs() {
      calls.push('dexscreener');
      return { pairs: [] };
    },
    getBestPair() {
      return input.dex ? { info: { imageUrl: input.dex } } : null;
    },
  };
  return {
    calls,
    resolver: createRobinhoodImageMetadataResolver({
      rpcClient, fetchImpl, blockscoutClient, dexClient,
    }),
  };
}

describe('Robinhood image metadata resolver', () => {
  it('uses the requested image-source priority and stops at the first valid image', async () => {
    const scenarios = [{
      input: { pons: 'ipfs://bafypons' },
      expectedUrl: 'https://ipfs.io/ipfs/bafypons',
      source: 'pons-onchain',
      launchpadId: 'pons',
      calls: ['pons'],
    }, {
      input: { stock: 'https://cdn.example/stock.png' },
      expectedUrl: 'https://cdn.example/stock.png',
      source: 'robinhood-stock-api',
      launchpadId: 'robinhood-stock',
      calls: ['pons', 'stock'],
    }, {
      input: {
        tokenUri: 'ipfs://bafymetadata',
        ipfsMetadata: { image: 'ipfs://bafybankr' },
        bankrVerified: true,
      },
      expectedUrl: 'https://ipfs.io/ipfs/bafybankr',
      source: 'bankr-ipfs',
      launchpadId: 'bankr-doppler',
      calls: ['pons', 'stock', 'tokenURI', 'ipfs', 'bankr'],
    }, {
      input: {
        tokenUri: 'ipfs://generic-metadata',
        ipfsMetadata: { image: 'ipfs://generic-image' },
      },
      expectedUrl: 'https://ipfs.io/ipfs/generic-image',
      source: 'bankr-ipfs',
      launchpadId: 'robinhood',
      calls: ['pons', 'stock', 'tokenURI', 'ipfs', 'bankr', 'creator'],
    }, {
      input: {
        blockscout: 'https://cdn.example/blockscout.png',
        creator: '0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf',
      },
      expectedUrl: 'https://cdn.example/blockscout.png',
      source: 'blockscout',
      launchpadId: 'launchhood',
      calls: ['pons', 'stock', 'tokenURI', 'blockscout', 'creator'],
    }, {
      input: { dex: 'https://cdn.example/dex.png' },
      expectedUrl: 'https://cdn.example/dex.png',
      source: 'dexscreener',
      launchpadId: 'robinhood',
      calls: ['pons', 'stock', 'tokenURI', 'blockscout', 'dexscreener', 'creator'],
    }];

    for (const scenario of scenarios) {
      const { resolver, calls } = harness(scenario.input);
      const result = await resolver.getTokenMetadata(TOKEN);
      assert.equal(result.imageUrl, scenario.expectedUrl);
      assert.equal(result.source, scenario.source);
      assert.equal(result.launchpadId, scenario.launchpadId);
      assert.deepEqual(calls, scenario.calls);
    }
  });

  it('still reaches DexScreener when Blockscout has a transport failure', async () => {
    const { resolver, calls } = harness({
      blockscoutError: true,
      dex: 'https://cdn.example/dex-after-error.png',
    });

    const result = await resolver.getTokenMetadata(TOKEN);

    assert.equal(result.imageUrl, 'https://cdn.example/dex-after-error.png');
    assert.equal(result.source, 'dexscreener');
    assert.equal(result.launchpadId, 'robinhood');
    assert.deepEqual(calls, [
      'pons', 'stock', 'tokenURI', 'blockscout', 'dexscreener', 'creator',
    ]);
  });
});
