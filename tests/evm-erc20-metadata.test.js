const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  AGGREGATE3_SELECTOR,
  MULTICALL3_ADDRESS,
  SELECTORS,
  createErc20MetadataReader,
  decodeAggregate3,
  decodeTextResult,
  encodeAggregate3,
} = require('../src/services/evm-erc20-metadata');

const TOKEN = '0x1111111111111111111111111111111111111111';

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function encodeBytes(hex) {
  const raw = hex.slice(2);
  return `${word(raw.length / 2)}${raw.padEnd(Math.ceil(raw.length / 64) * 64, '0')}`;
}

function stringResult(value) {
  const raw = Buffer.from(value, 'utf8').toString('hex');
  return `0x${word(32)}${word(raw.length / 2)}${raw.padEnd(Math.ceil(raw.length / 64) * 64, '0')}`;
}

function bytes32Result(value) {
  return `0x${Buffer.from(value, 'utf8').toString('hex').padEnd(64, '0')}`;
}

function uintResult(value) {
  return `0x${word(value)}`;
}

function aggregateResult(results) {
  const tuples = results.map((result) => (
    `${word(result.success ? 1 : 0)}${word(64)}${encodeBytes(result.returnData)}`
  ));
  let offset = results.length * 32;
  const offsets = tuples.map((tuple) => {
    const current = word(offset);
    offset += tuple.length / 2;
    return current;
  }).join('');
  return `0x${word(32)}${word(results.length)}${offsets}${tuples.join('')}`;
}

function successfulResults(overrides = {}) {
  return [
    { success: true, returnData: overrides.name || stringResult('Meme Token') },
    { success: true, returnData: overrides.symbol || bytes32Result('MEME') },
    { success: true, returnData: overrides.decimals || uintResult(18) },
    { success: true, returnData: overrides.totalSupply || uintResult(10n ** 27n) },
  ];
}

function createRpc(handler) {
  const calls = [];
  return {
    calls,
    request: async (method, params, requestOptions) => {
      calls.push({ method, params, requestOptions });
      return handler(method, params, calls.length, requestOptions);
    },
  };
}

describe('EVM ERC-20 metadata reader', () => {
  it('encodes aggregate3 calls and decodes dynamic tuple results exactly', () => {
    const calldata = encodeAggregate3([
      { target: TOKEN, allowFailure: true, callData: SELECTORS.name },
      { target: TOKEN, allowFailure: false, callData: SELECTORS.decimals },
    ]);
    const encodedResult = aggregateResult([
      { success: true, returnData: stringResult('Token') },
      { success: false, returnData: '0x' },
    ]);

    assert.equal(calldata.slice(0, 10), AGGREGATE3_SELECTOR);
    assert.equal(calldata.includes(TOKEN.slice(2)), true);
    assert.deepEqual(decodeAggregate3(encodedResult, 2), [
      { success: true, returnData: stringResult('Token') },
      { success: false, returnData: '0x' },
    ]);
  });

  it('reads standard strings, bytes32 symbols, decimals and large supplies via Multicall3', async () => {
    const rpc = createRpc((method, params) => {
      if (method === 'eth_getCode') return '0x6000';
      assert.equal(params[0].to, MULTICALL3_ADDRESS);
      return aggregateResult(successfulResults());
    });
    const reader = createErc20MetadataReader({ rpcClient: rpc });
    const metadata = await reader.getMetadata(TOKEN);

    assert.equal(metadata.name, 'Meme Token');
    assert.equal(metadata.symbol, 'MEME');
    assert.equal(metadata.decimals, 18);
    assert.equal(metadata.totalSupplyRaw, (10n ** 27n).toString());
    assert.equal(metadata.status, 'complete');
    assert.equal(metadata.usable, true);
    assert.equal(metadata.transport, 'multicall3');
    assert.equal(rpc.calls.length, 2);
  });

  it('falls back to individual eth_call reads when Multicall3 has no bytecode', async () => {
    const responses = {
      [SELECTORS.name]: stringResult('Fallback'),
      [SELECTORS.symbol]: stringResult('FB'),
      [SELECTORS.decimals]: uintResult(6),
      [SELECTORS.totalSupply]: uintResult(123456789n),
    };
    const rpc = createRpc((method, params) => (
      method === 'eth_getCode' ? '0x' : responses[params[0].data]
    ));
    const metadata = await createErc20MetadataReader({ rpcClient: rpc }).getMetadata(TOKEN);

    assert.equal(metadata.transport, 'individual');
    assert.equal(metadata.decimals, 6);
    assert.equal(metadata.totalSupplyRaw, '123456789');
    assert.equal(rpc.calls.filter((call) => call.method === 'eth_call').length, 4);
  });

  it('falls back to individual calls when aggregate3 reverts', async () => {
    const responses = successfulResults().map((result) => result.returnData);
    let individualIndex = 0;
    const rpc = createRpc((method, params) => {
      if (method === 'eth_getCode') return '0x6000';
      if (params[0].to === MULTICALL3_ADDRESS) throw new Error('aggregate reverted');
      return responses[individualIndex++];
    });
    const metadata = await createErc20MetadataReader({ rpcClient: rpc }).getMetadata(TOKEN);

    assert.equal(metadata.transport, 'individual');
    assert.equal(metadata.usable, true);
    assert.equal(rpc.calls.filter((call) => call.method === 'eth_call').length, 5);
  });

  it('returns partial metadata for optional field reverts without losing numeric identity', async () => {
    const results = successfulResults();
    results[0] = { success: false, returnData: '0x' };
    results[1] = { success: true, returnData: '0x1234' };
    const rpc = createRpc((method) => (
      method === 'eth_getCode' ? '0x6000' : aggregateResult(results)
    ));
    const metadata = await createErc20MetadataReader({ rpcClient: rpc }).getMetadata(TOKEN);

    assert.equal(metadata.name, null);
    assert.equal(metadata.symbol, null);
    assert.equal(metadata.usable, true);
    assert.equal(metadata.status, 'partial');
    assert.deepEqual(metadata.errors, ['name_call_failed', 'symbol_decode_failed']);
  });

  it('marks metadata unusable when decimals or totalSupply cannot be trusted', async () => {
    const results = successfulResults({ decimals: uintResult(256) });
    results[3] = { success: false, returnData: '0x' };
    const rpc = createRpc((method) => (
      method === 'eth_getCode' ? '0x6000' : aggregateResult(results)
    ));
    const metadata = await createErc20MetadataReader({ rpcClient: rpc }).getMetadata(TOKEN);

    assert.equal(metadata.decimals, null);
    assert.equal(metadata.totalSupplyRaw, null);
    assert.equal(metadata.usable, false);
    assert.equal(metadata.status, 'unusable');
    assert.deepEqual(metadata.errors, ['decimals_decode_failed', 'totalSupply_call_failed']);
  });

  it('caches completed reads and coalesces concurrent requests', async () => {
    let now = 1000;
    let aggregateCalls = 0;
    const rpc = createRpc(async (method) => {
      if (method === 'eth_getCode') return '0x6000';
      aggregateCalls += 1;
      await Promise.resolve();
      return aggregateResult(successfulResults());
    });
    const reader = createErc20MetadataReader({ rpcClient: rpc, ttlMs: 100, now: () => now });
    const [first, concurrent] = await Promise.all([reader.getMetadata(TOKEN), reader.getMetadata(TOKEN)]);
    const cached = await reader.getMetadata(TOKEN);
    now = 1101;
    const refreshed = await reader.getMetadata(TOKEN);

    assert.equal(first.cached, false);
    assert.equal(concurrent.cached, false);
    assert.equal(cached.cached, true);
    assert.equal(refreshed.cached, false);
    assert.equal(aggregateCalls, 2);
  });

  it('reads totalSupply at an exact block with a bounded independent cache', async () => {
    const rpc = createRpc((method, params) => {
      assert.equal(method, 'eth_call');
      assert.equal(params[0].data, SELECTORS.totalSupply);
      return uintResult(BigInt(params[1]));
    });
    const reader = createErc20MetadataReader({
      rpcClient: rpc,
      maxCacheEntries: 2,
    });

    const first = await reader.getTotalSupply(TOKEN, { blockTag: '0x10' });
    const cached = await reader.getTotalSupply(TOKEN, { blockTag: '0x10' });
    await reader.getTotalSupply(TOKEN, { blockTag: '0x11' });
    await reader.getTotalSupply(TOKEN, { blockTag: '0x12' });

    assert.equal(first.totalSupplyRaw, '16');
    assert.equal(first.status, 'exact_block');
    assert.equal(cached.cached, true);
    assert.equal(rpc.calls.length, 3);
    assert.equal(reader.getSupplyCacheSize(), 2);
  });

  it('returns an unavailable supply result instead of throwing historical state failures', async () => {
    const rpc = createRpc(() => { throw new Error('missing trie node'); });
    const result = await createErc20MetadataReader({
      rpcClient: rpc,
      useMulticall: false,
    }).getTotalSupply(TOKEN, { blockTag: '0x10' });

    assert.equal(result.usable, false);
    assert.equal(result.totalSupplyRaw, null);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.blockTag, '0x10');
  });

  it('requests historical RPC fallback and propagates exhausted transient supply failures', async () => {
    const error = new Error('rate limited');
    error.code = 'rate_limited';
    error.retryable = true;
    const rpc = createRpc(() => { throw error; });
    const reader = createErc20MetadataReader({ rpcClient: rpc, useMulticall: false });

    await assert.rejects(reader.getTotalSupply(TOKEN, { blockTag: '0x10' }), error);
    assert.deepEqual(rpc.calls[0].requestOptions, { fallbackOnRpcError: true });
  });

  it('does not fan out transient Multicall failures into individual requests', async () => {
    const error = new Error('rate limited');
    error.code = 'rate_limited';
    error.retryable = true;
    const rpc = createRpc((method) => {
      if (method === 'eth_getCode') return '0x6000';
      throw error;
    });

    await assert.rejects(createErc20MetadataReader({ rpcClient: rpc }).getMetadata(TOKEN), error);
    const ethCalls = rpc.calls.filter((call) => call.method === 'eth_call');
    assert.equal(ethCalls.length, 1);
    assert.deepEqual(ethCalls[0].requestOptions, { fallbackOnRpcError: true });
  });

  it('deduplicates Multicall3 code checks and retries them after transient failure', async () => {
    let codeCalls = 0;
    const rpc = createRpc(async (method, params) => {
      if (method === 'eth_getCode') {
        codeCalls += 1;
        await Promise.resolve();
        if (codeCalls === 1) throw new Error('temporary transport failure');
        return '0x6000';
      }
      if (params[0].to === MULTICALL3_ADDRESS) return aggregateResult(successfulResults());
      return successfulResults()[Object.values(SELECTORS).indexOf(params[0].data)].returnData;
    });
    const reader = createErc20MetadataReader({ rpcClient: rpc, failureTtlMs: 0 });
    await Promise.all([
      reader.getMetadata(TOKEN),
      reader.getMetadata('0x2222222222222222222222222222222222222222'),
    ]);
    await reader.getMetadata('0x3333333333333333333333333333333333333333');

    assert.equal(codeCalls, 2);
    assert.equal(rpc.calls.some((call) => call.params?.[0]?.to === MULTICALL3_ADDRESS), true);
  });

  it('rejects malformed text and aggregate result envelopes', () => {
    assert.equal(decodeTextResult(bytes32Result('BYTES32'), 'symbol'), 'BYTES32');
    assert.throws(() => decodeTextResult('0x1234', 'name'), /outside ABI data/);
    assert.throws(() => decodeAggregate3(aggregateResult(successfulResults()), 3), /expected 3/);
    assert.throws(() => encodeAggregate3([]), /calls are required/);
  });
});
