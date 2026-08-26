const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBlockscoutMetadataClient,
  __private: { boundedTimeout },
} = require('../src/services/robinhood-blockscout-metadata');

const TOKEN = `0x${'1'.repeat(40)}`;
const TOKEN_2 = `0x${'3'.repeat(40)}`;

function response(status, payload, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() { return payload; },
  };
}

describe('Robinhood Blockscout metadata client', () => {
  it('honors long bounded timeouts required by slow contract creation lookups', () => {
    assert.equal(boundedTimeout(30_000), 30_000);
    assert.equal(boundedTimeout(90_000), 60_000);
  });

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
    const transactionHash = `0x${'4'.repeat(64)}`;
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(200, {
        hash: TOKEN,
        creator_address_hash: creator.toUpperCase(),
        creation_transaction_hash: transactionHash.toUpperCase(),
      }),
    });

    assert.equal(await client.getContractCreator(TOKEN), creator);
    assert.deepEqual(await client.getContractCreation(TOKEN), {
      tokenAddress: TOKEN, creatorAddress: creator, transactionHash,
    });
  });

  it('resolves up to ten contract creators in one Blockscout request', async () => {
    const creator = `0x${'2'.repeat(40)}`;
    const transactionHash = `0x${'4'.repeat(64)}`;
    let requestedUrl;
    const client = createRobinhoodBlockscoutMetadataClient({
      apiUrl: 'https://api.blockscout.com/v2/api?chain_id=4663',
      apiKey: 'proapi_test',
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return response(200, {
          status: '1',
          result: [{ contractAddress: TOKEN, contractCreator: creator, txHash: transactionHash }],
        }, { 'x-credits-remaining': '99980' });
      },
    });

    assert.deepEqual(await client.getContractCreators([TOKEN.toUpperCase(), TOKEN_2]), [
      { tokenAddress: TOKEN, creatorAddress: creator, transactionHash },
      { tokenAddress: TOKEN_2, creatorAddress: null, transactionHash: null },
    ]);
    assert.equal(requestedUrl.searchParams.get('action'), 'getcontractcreation');
    assert.equal(requestedUrl.searchParams.get('chain_id'), '4663');
    assert.equal(requestedUrl.searchParams.get('apikey'), 'proapi_test');
    assert.equal(requestedUrl.searchParams.get('contractaddresses'), `${TOKEN},${TOKEN_2}`);
    assert.equal(client.getCreditsRemaining(), 99980);
    await assert.rejects(
      () => client.getContractCreators(Array.from({ length: 11 }, () => TOKEN)),
      /1\.\.10/
    );
  });

  it('classifies an exhausted PRO allowance without treating it as a transient 429', async () => {
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(429, null, { 'x-credits-remaining': '0' }),
    });

    await assert.rejects(() => client.getContractCreators([TOKEN]), (error) => {
      assert.equal(error.code, 'credits_exhausted');
      assert.equal(error.creditsRemaining, 0);
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it('rejects HTTP failures and mismatched token identities', async () => {
    const failed = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(503, null),
    });
    await assert.rejects(() => failed.getTokenMetadata(TOKEN), (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.equal(error.retryable, true);
      return true;
    });

    const mismatched = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(200, {
        address_hash: `0x${'2'.repeat(40)}`,
      }),
    });
    await assert.rejects(() => mismatched.getTokenMetadata(TOKEN), /address mismatch/);
  });
});
