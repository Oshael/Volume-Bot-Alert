const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBlockscoutMetadataClient,
} = require('../src/services/robinhood-blockscout-metadata');

const TOKEN = `0x${'1'.repeat(40)}`;

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; },
  };
}

describe('Robinhood Blockscout metadata client', () => {
  it('normalizes token metadata and sanitizes its image', async () => {
    const calls = [];
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return response(200, {
          address_hash: TOKEN,
          symbol: ' TKN ',
          name: ' Token Name ',
          decimals: '18',
          reputation: 'ok',
          icon_url: 'ipfs://bafy-token-image',
        });
      },
    });

    const metadata = await client.getTokenMetadata(TOKEN.toUpperCase());

    assert.equal(metadata.address, TOKEN);
    assert.equal(metadata.symbol, 'TKN');
    assert.equal(metadata.name, 'Token Name');
    assert.equal(metadata.decimals, 18);
    assert.equal(metadata.imageUrl, 'https://ipfs.io/ipfs/bafy-token-image');
    assert.match(calls[0].url, new RegExp(`${TOKEN}$`));
    assert.equal(calls[0].options.headers.accept, 'application/json');
  });

  it('treats a missing token as a successful negative lookup', async () => {
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(404, null),
    });

    const metadata = await client.getTokenMetadata(TOKEN);

    assert.equal(metadata.available, false);
    assert.equal(metadata.imageUrl, null);
  });

  it('reads and validates the contract creator from the address endpoint', async () => {
    const creator = `0x${'2'.repeat(40)}`;
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(200, {
        hash: TOKEN,
        creator_address_hash: creator.toUpperCase(),
      }),
    });

    assert.equal(await client.getContractCreator(TOKEN), creator);
  });

  it('rejects HTTP failures and mismatched token identities', async () => {
    const failed = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(503, null),
    });
    await assert.rejects(() => failed.getTokenMetadata(TOKEN), /HTTP 503/);

    const mismatched = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(200, {
        address_hash: `0x${'2'.repeat(40)}`,
      }),
    });
    await assert.rejects(() => mismatched.getTokenMetadata(TOKEN), /address mismatch/);
  });
});
