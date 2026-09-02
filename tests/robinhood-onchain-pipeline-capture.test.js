const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodOnchainPipeline } = require('../src/services/robinhood-onchain-pipeline');
const v4 = require('../src/services/uniswap-v4-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');

const rpcClient = { request: async () => '0x0' };
const timestampEnricher = { enrich: async (logs) => logs, snapshot: () => ({}) };

function trackerStub(event) {
  return {
    processLog: () => event,
    getPair: () => undefined,
    getPool: () => undefined,
    getTrackedPairs: () => [],
    getTrackedPools: () => [],
    getTrackedPairCount: () => 0,
    getTrackedPoolCount: () => 0,
    removePair: () => false,
    removePool: () => false,
  };
}

const captureBuilderStub = {
  buildMarketCapture: async (swap) => ({
    protocol: swap.protocol, marketKey: 'm', evidenceVersion: 1, evidence: { captured: swap.tokenAddress },
  }),
  buildEventCapture: (event) => ({
    protocol: event.protocol, marketKey: null, evidenceVersion: 1, evidence: { event },
  }),
  buildDiscoveryCapture: (event) => ({
    protocol: event.protocol ?? null, marketKey: null, evidenceVersion: 1, evidence: { event },
  }),
};

function buildPipeline({ marketEvent, discoveryEvent, captureMode = true, captureBuilder = captureBuilderStub }) {
  return createRobinhoodOnchainPipeline({
    rpcClient,
    timestampEnricher,
    now: () => 1750000000000,
    captureMode,
    captureBuilder,
    v2Tracker: trackerStub(marketEvent),
    v3Tracker: trackerStub(discoveryEvent || marketEvent),
    v4Tracker: trackerStub(marketEvent),
  });
}

const V4_LOG = { address: v4.ROBINHOOD_V4_POOL_MANAGER, transactionHash: `0x${'a'.repeat(64)}`, logIndex: 0, blockNumber: 100 };
const V3_FACTORY_LOG = { address: v3.ROBINHOOD_V3_FACTORY, transactionHash: `0x${'b'.repeat(64)}`, logIndex: 0, blockNumber: 100 };

describe('pipeline capture mode', () => {
  it('attaches capture evidence to a market swap entry', async () => {
    const pipeline = buildPipeline({
      marketEvent: { kind: 'swap', protocol: 'uniswap-v4', tokenAddress: '0xtok', timestampMs: 1750000000000 },
    });
    const entries = await pipeline.processMarketRange([V4_LOG]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].capture.evidence.captured, '0xtok');
    assert.equal(entries[0].observation, undefined);
  });

  it('marks only catch-up ranges to skip historical V3 balance reads', async () => {
    const optionsSeen = [];
    const pipeline = buildPipeline({
      marketEvent: { kind: 'swap', protocol: 'uniswap-v3', tokenAddress: '0xtok', timestampMs: 1750000000000 },
      captureBuilder: {
        ...captureBuilderStub,
        buildMarketCapture: async (swap, options) => {
          optionsSeen.push(options);
          return { protocol: swap.protocol, marketKey: 'm', evidenceVersion: 2, evidence: {} };
        },
      },
    });
    await pipeline.processMarketRange([V4_LOG], { backfill: true });
    await pipeline.processMarketRange([V4_LOG], { backfill: false });
    assert.deepEqual(optionsSeen, [{ skipV3Balances: true }, { skipV3Balances: false }]);
  });

  it('attaches capture evidence to a non-swap market event entry', async () => {
    const pipeline = buildPipeline({
      marketEvent: { kind: 'modify-liquidity', protocol: 'uniswap-v4', poolId: '0xp' },
    });
    const entries = await pipeline.processMarketRange([V4_LOG]);
    assert.equal(entries[0].capture.evidence.event.kind, 'modify-liquidity');
  });

  it('attaches capture evidence to a discovery entry', async () => {
    const pipeline = buildPipeline({
      marketEvent: { kind: 'ignored' },
      discoveryEvent: { kind: 'pool-created', protocol: 'uniswap-v3', poolAddress: '0xp' },
    });
    const entries = await pipeline.processDiscoveryRange([V3_FACTORY_LOG]);
    assert.equal(entries[0].capture.evidence.event.kind, 'pool-created');
  });

  it('does not attach capture nor call the builder when capture mode is off', async () => {
    const throwingBuilder = {
      buildMarketCapture: () => { throw new Error('must not run'); },
      buildEventCapture: () => { throw new Error('must not run'); },
      buildDiscoveryCapture: () => { throw new Error('must not run'); },
    };
    const pipeline = buildPipeline({
      marketEvent: { kind: 'modify-liquidity', protocol: 'uniswap-v4', poolId: '0xp' },
      captureMode: false,
      captureBuilder: throwingBuilder,
    });
    const entries = await pipeline.processMarketRange([V4_LOG]);
    assert.equal(entries[0].capture, undefined);
  });
});
