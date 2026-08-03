const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHeadCaptureBuilder,
} = require('../src/services/robinhood-head-capture-builder');
const { ROBINHOOD_WETH } = require('../src/services/evm-market-metrics');

const TOKEN = '0xtoken';

function metadataReaderStub(overrides = {}) {
  return {
    getMetadata: async (address) => {
      if (address === ROBINHOOD_WETH) return { usable: true, address, decimals: 18 };
      return {
        usable: true, address, name: 'Token', symbol: 'TKN', decimals: 18,
        totalSupplyRaw: '1000000000000000000000',
      };
    },
    getBalanceOf: async (_token, _pool, { blockTag }) => ({ balanceRaw: blockTag === '0x64' ? '500' : '0' }),
    ...overrides,
  };
}

const quoteReaderStub = {
  getCurrent: async () => ({ priceUsd: '2000.5', source: 'canonical-weth-usdg-3000', blockTag: '0x10' }),
};

function builder(overrides = {}) {
  return createRobinhoodHeadCaptureBuilder({
    metadataReader: metadataReaderStub(overrides.metadataReader),
    quoteReader: overrides.quoteReader || quoteReaderStub,
    classifyEligibility: overrides.classifyEligibility || (() => ({ eligible: true })),
  });
}

function v3Swap(extra = {}) {
  return {
    protocol: 'uniswap-v3', tokenAddress: TOKEN, quoteAddress: ROBINHOOD_WETH,
    quoteIndex: 1, blockNumber: 100, timestampMs: 1750000000000,
    poolAddress: '0xpool', sqrtPriceX96: '123', marketKey: 'robinhood:uniswap-v3:x',
    ...extra,
  };
}

describe('head capture builder — market', () => {
  it('freezes V3 pool balances and the quote provenance', async () => {
    const capture = await builder().buildMarketCapture(v3Swap());
    assert.equal(capture.protocol, 'uniswap-v3');
    assert.equal(capture.evidence.v3.tokenBalanceRaw, '500');
    assert.equal(capture.evidence.v3.blockTag, '0x64');
    assert.equal(capture.evidence.quoteUsd.status, 'observed');
    assert.equal(capture.evidence.quoteUsd.blockTag, '0x10');
    assert.equal(capture.evidence.tokenMetadata.tokenSupplyStatus, 'latest_call');
  });

  it('captures a V2 swap with log reserves and no pool-balance reads', async () => {
    const capture = await builder().buildMarketCapture({
      protocol: 'uniswap-v2', tokenAddress: TOKEN, quoteAddress: ROBINHOOD_WETH,
      quoteIndex: 0, blockNumber: 100, timestampMs: 1750000000000,
      quoteReserveRaw: '888', marketKey: 'robinhood:uniswap-v2:x',
    });
    assert.deepEqual(capture.evidence.v2, { quoteReserveRaw: '888' });
    assert.equal(capture.evidence.v3, undefined);
  });

  const rejections = [
    ['ineligible token', { classifyEligibility: () => ({ eligible: false, reason: 'token_ineligible' }) }, {}, 'token_ineligible'],
    ['unusable token metadata', {}, { metadataReader: { getMetadata: async () => ({ usable: false }) } }, 'token_metadata_unusable'],
  ];

  for (const [name, over, mdOver, expected] of rejections) {
    it(`emits a rejection capture (cursor still advances): ${name}`, async () => {
      const b = builder({ ...over, ...mdOver });
      const capture = await b.buildMarketCapture(v3Swap());
      assert.equal(capture.evidence.rejected, expected);
    });
  }

  it('rejects when the quote USD is unavailable', async () => {
    const capture = await builder().buildMarketCapture(v3Swap({ quoteAddress: '0xunknownquote' }));
    assert.equal(capture.evidence.rejected, 'quote_usd_unavailable');
  });

  it('emits a terminal rejection capture when V3 pool state is pruned (null balance)', async () => {
    const b = builder({ metadataReader: { getBalanceOf: async () => ({ balanceRaw: null }) } });
    const capture = await b.buildMarketCapture(v3Swap());
    assert.equal(capture.evidence.rejected, 'v3_pool_balance_unavailable');
  });

  it('propagates a transient balance RPC failure instead of zeroing', async () => {
    const b = builder({ metadataReader: { getBalanceOf: async () => { const e = new Error('rpc'); e.retryable = true; throw e; } } });
    await assert.rejects(() => b.buildMarketCapture(v3Swap()), /rpc/);
  });
});

describe('head capture builder — events and discovery', () => {
  it('captures a non-swap market event as a log passthrough', () => {
    const capture = builder().buildEventCapture({ kind: 'modify-liquidity', protocol: 'uniswap-v4', poolId: '0xp' });
    assert.equal(capture.evidence.event.kind, 'modify-liquidity');
  });

  it('freezes the NOXA validation result on a discovery launch', () => {
    const capture = builder().buildDiscoveryCapture(
      { kind: 'noxa-launch', protocol: 'uniswap-v3', marketKey: 'robinhood:uniswap-v3:y' },
      { accepted: true, canonicalPoolAddress: '0xpool', tokenCodeBytes: 100, poolCodeBytes: 200 }
    );
    assert.equal(capture.evidence.noxa.accepted, true);
    assert.equal(capture.evidence.noxa.canonicalPoolAddress, '0xpool');
  });
});
