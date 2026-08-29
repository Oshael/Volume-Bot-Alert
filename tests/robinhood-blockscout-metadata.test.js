const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBlockscoutMetadataClient,
  requestWithRetry,
  __private: { boundedTimeout, parseRetryAfterMs },
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
    assert.equal(parseRetryAfterMs('3'), 3000);
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

  it('recovers a creation transaction from the first mint when address lookup fails', async () => {
    const creator = `0x${'2'.repeat(40)}`;
    const transactionHash = `0x${'4'.repeat(64)}`;
    const calls = [];
    const client = createRobinhoodBlockscoutMetadataClient({
      apiKey: 'proapi_test',
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return response(503, null);
        return response(200, { status: '1', result: [{
          contractAddress: TOKEN, from: `0x${'0'.repeat(40)}`,
          to: creator, hash: transactionHash,
        }] });
      },
    });

    assert.deepEqual(await client.getContractCreation(TOKEN), {
      tokenAddress: TOKEN, creatorAddress: creator, transactionHash,
    });
    const fallback = new URL(calls[1]);
    assert.equal(fallback.searchParams.get('action'), 'tokentx');
    assert.equal(fallback.searchParams.get('sort'), 'asc');
    assert.equal(fallback.searchParams.get('apikey'), 'proapi_test');
  });

  it('uses the PRO creation endpoint when the public address endpoint returns 403', async () => {
    const creator = `0x${'2'.repeat(40)}`;
    const transactionHash = `0x${'4'.repeat(64)}`;
    const calls = [];
    const client = createRobinhoodBlockscoutMetadataClient({
      apiUrl: 'https://api.blockscout.com/v2/api?chain_id=4663',
      apiKey: 'proapi_test',
      fetchImpl: async (url) => {
        calls.push(new URL(url));
        if (calls.length === 1) return response(403, null);
        return response(200, { status: '1', result: [{
          contractAddress: TOKEN, contractCreator: creator, txHash: transactionHash,
        }] });
      },
    });

    assert.deepEqual(await client.getContractCreation(TOKEN), {
      tokenAddress: TOKEN, creatorAddress: creator, transactionHash,
    });
    assert.equal(calls[1].origin, 'https://api.blockscout.com');
    assert.equal(calls[1].searchParams.get('action'), 'getcontractcreation');
    assert.equal(calls[1].searchParams.get('apikey'), 'proapi_test');
  });

  it('does not treat an ordinary token transfer as a contract creation hint', async () => {
    let calls = 0;
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return response(503, null);
        return response(200, { result: [{
          contractAddress: TOKEN, from: `0x${'5'.repeat(40)}`,
          to: `0x${'2'.repeat(40)}`, hash: `0x${'4'.repeat(64)}`,
        }] });
      },
    });

    assert.equal(await client.getContractCreation(TOKEN), null);
  });

  it('resolves exact internal CREATE2 evidence from a transaction trace', async () => {
    const creator = `0x${'2'.repeat(40)}`;
    const transactionHash = `0x${'4'.repeat(64)}`;
    let requestedUrl;
    const client = createRobinhoodBlockscoutMetadataClient({
      apiKey: 'proapi_test',
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return response(200, {
          items: [{
            type: 'create2', success: true, transaction_hash: transactionHash.toUpperCase(),
            from: { hash: creator.toUpperCase() }, created_contract: { hash: TOKEN.toUpperCase() },
          }],
          next_page_params: null,
        });
      },
    });

    assert.deepEqual(await client.getInternalContractCreation(transactionHash, TOKEN), {
      tokenAddress: TOKEN, transactionHash, factoryAddress: creator,
    });
    assert.match(requestedUrl, new RegExp(`${transactionHash}/internal-transactions$`));
  });

  it('falls back to legacy internal traces when the native endpoint is unavailable', async () => {
    const factory = `0x${'2'.repeat(40)}`;
    const transactionHash = `0x${'4'.repeat(64)}`;
    const calls = [];
    const client = createRobinhoodBlockscoutMetadataClient({
      apiUrl: 'https://api.blockscout.com/v2/api?chain_id=4663',
      apiKey: 'proapi_test',
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return response(403, null);
        return response(200, { status: '1', message: 'OK', result: [{
          type: 'create2', isError: '0', transactionHash,
          contractAddress: TOKEN, from: factory,
        }] });
      },
    });

    assert.deepEqual(await client.getInternalContractCreation(transactionHash, TOKEN), {
      tokenAddress: TOKEN, transactionHash, factoryAddress: factory,
    });
    const fallback = new URL(calls[1]);
    assert.equal(fallback.searchParams.get('action'), 'txlistinternal');
    assert.equal(fallback.searchParams.get('txhash'), transactionHash);
    assert.equal(fallback.origin, 'https://api.blockscout.com');
    assert.equal(fallback.searchParams.get('apikey'), 'proapi_test');
  });

  it('finds contract creation evidence inside one exact deployment block', async () => {
    const creator = `0x${'2'.repeat(40)}`;
    const transactionHash = `0x${'4'.repeat(64)}`;
    let requestedUrl;
    const client = createRobinhoodBlockscoutMetadataClient({
      apiKey: 'proapi_test',
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return response(200, { result: [{
          type: 'create2', isError: '0', hash: transactionHash,
          contractAddress: TOKEN, from: creator,
        }] });
      },
    });

    assert.deepEqual(await client.getContractCreationAtBlock(TOKEN, '40'), {
      tokenAddress: TOKEN, creatorAddress: creator, transactionHash,
    });
    assert.equal(requestedUrl.searchParams.get('action'), 'txlistinternal');
    assert.equal(requestedUrl.searchParams.get('startblock'), '40');
    assert.equal(requestedUrl.searchParams.get('endblock'), '40');
    assert.equal(requestedUrl.searchParams.get('include_zero_value'), 'true');
    assert.equal(requestedUrl.searchParams.get('apikey'), 'proapi_test');
  });

  it('honors Blockscout Retry-After when retrying a shared rate limit', async () => {
    const waits = [];
    let attempts = 0;
    const result = await requestWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('limited'), {
        code: 'http_error', httpStatus: 429, retryAfterMs: 4000,
      });
      return 'ok';
    }, { requestRetries: 1, retryDelayMs: 500 }, async (ms) => { waits.push(ms); });

    assert.deepEqual(result, { value: 'ok', retries: 1 });
    assert.deepEqual(waits, [4000]);
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

  it('exposes the provider retry delay on a shared 429 response', async () => {
    const client = createRobinhoodBlockscoutMetadataClient({
      fetchImpl: async () => response(429, null, {
        'retry-after': '4', 'x-credits-remaining': '100',
      }),
    });

    await assert.rejects(() => client.getTokenMetadata(TOKEN), (error) => {
      assert.equal(error.code, 'http_error');
      assert.equal(error.retryAfterMs, 4000);
      assert.equal(error.retryable, true);
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
