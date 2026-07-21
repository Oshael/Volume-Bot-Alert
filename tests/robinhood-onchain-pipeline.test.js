const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const v2Fixture = require('../data/fixtures/robinhood-uniswap-v2.json');
const v3Fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const v4Fixture = require('../data/fixtures/robinhood-uniswap-v4.json');
const noxaFixture = require('../data/fixtures/robinhood-noxa-launch.json');
const { createRobinhoodOnchainPipeline, sortLogs } = require('../src/services/robinhood-onchain-pipeline');

const NOW = Number(BigInt(v4Fixture.swap.blockTimestamp) * 1000n) + 1000;

function metadataReader(overrides = {}) {
  return {
    getMetadata: async (address) => {
      if (overrides[address]) return overrides[address];
      const isUsdg = address === v4Fixture.expected.currency1;
      return {
        address,
        name: 'Token',
        symbol: isUsdg ? 'USDG' : 'TOKEN',
        decimals: isUsdg ? 6 : 18,
        totalSupplyRaw: isUsdg ? '1' : (10n ** 27n).toString(),
        usable: true,
      };
    },
  };
}

function createRpc(timestamp = v4Fixture.swap.blockTimestamp) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_getBlockByNumber') return { timestamp };
      throw new Error(`Unexpected RPC method ${method}`);
    },
  };
}

function createPipeline(options = {}) {
  return createRobinhoodOnchainPipeline({
    rpcClient: options.rpcClient || createRpc(),
    metadataReader: options.metadataReader || metadataReader(),
    quoteReader: options.quoteReader || { getSnapshot: async () => ({ priceUsd: '1800', source: 'test' }) },
    policyOptions: options.policyOptions,
    timestampConcurrency: options.timestampConcurrency,
    observationConcurrency: options.observationConcurrency,
    supplyDeltaReader: options.supplyDeltaReader,
    retainRollbackState: options.retainRollbackState,
    rollbackStateLimit: options.rollbackStateLimit,
    windowAggregationEnabled: options.windowAggregationEnabled,
    socialMetadataQueue: options.socialMetadataQueue,
    noxaValidator: options.noxaValidator,
    now: () => options.now ?? NOW,
    seedLogs: {
      v2: [v2Fixture.pairCreated],
      v3: [v3Fixture.poolCreated],
      v4: [v4Fixture.initialize],
    },
  });
}

describe('Robinhood onchain pipeline', () => {
  it('seeds verified v2/v3/v4 registries without treating fixtures as observations', () => {
    const pipeline = createPipeline();
    const snapshot = pipeline.snapshot();

    assert.deepEqual(snapshot.tracked, { v2: 1, v3: 1, v4: 1 });
    assert.equal(snapshot.metrics.swapsAccepted, 0);
    assert.deepEqual(snapshot.windows, []);
    assert.deepEqual(new Set(pipeline.getTrackedMarketAddresses()), new Set([
      v2Fixture.expected.pair,
      v3Fixture.expected.pool,
      v4Fixture.poolManager,
    ]));
  });

  it('translates a real v4 swap through metadata, policy and exact windows', async () => {
    const pipeline = createPipeline();
    const accepted = await pipeline.processMarketLogs([v4Fixture.swap]);
    const snapshot = pipeline.snapshot();
    const oneMinute = snapshot.windows.find((window) => window.window === '1m');

    assert.equal(accepted.length, 1);
    assert.match(accepted[0].priceUsd, /^0\.0000006757149384724817921743/);
    assert.equal(accepted[0].liquidityUsd, null);
    assert.equal(accepted[0].liquidityStatus, 'requires_tick_liquidity_distribution');
    assert.equal(accepted[0].liquidityConfidence, 'none');
    assert.match(accepted[0].liquidityRaw, /^\d+$/);
    assert.equal(oneMinute.swaps, 1);
    assert.equal(oneMinute.sells, 1);
    assert.equal(oneMinute.volumeUsd, '0.7988');
    assert.equal(snapshot.metrics.swapsDecoded, 1);
    assert.equal(snapshot.metrics.swapsAccepted, 1);
    assert.equal(snapshot.metrics.protocols['uniswap-v4'].swapsAccepted, 1);
    assert.equal(snapshot.metrics.protocols['uniswap-v4'].logs, 1);
    assert.equal(snapshot.metrics.withoutQuoteRate, 0);
  });

  it('attaches a manipulable spot liquidity estimate only to v2 observations', async () => {
    const pipeline = createPipeline({
      now: Number(BigInt(v2Fixture.swap.blockTimestamp) * 1000n) + 1000,
    });
    const accepted = await pipeline.processMarketLogs([v2Fixture.sync, v2Fixture.swap]);

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].liquidityUsd, '36.0036');
    assert.equal(accepted[0].liquidityRaw, null);
    assert.equal(accepted[0].liquidityStatus, 'spot_estimate_from_double_quote_reserve');
    assert.equal(accepted[0].liquidityConfidence, 'medium');
    assert.equal(accepted[0].liquidityWarning, 'spot_price_and_reserves_are_manipulable');
  });

  it('returns persistence entries for discoveries and rejected market enrichment', async () => {
    const pipeline = createPipeline({
      policyOptions: { extraDenied: { TEST: v4Fixture.expected.currency0 } },
    });
    const discoveries = await pipeline.processDiscoveryRange([v4Fixture.initialize]);
    const market = await pipeline.processMarketRange([v4Fixture.swap]);

    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].event.kind, 'initialize');
    assert.equal(market.length, 1);
    assert.equal(market[0].event.kind, 'swap');
    assert.equal(market[0].observation.accepted, false);
  });

  it('does not persist topic-matched logs emitted by markets outside the registry', async () => {
    const rpcClient = createRpc();
    const pipeline = createPipeline({ rpcClient });
    const entries = await pipeline.processMarketRange([{
      ...v4Fixture.swap,
      address: '0x1111111111111111111111111111111111111111',
    }]);

    assert.deepEqual(entries, []);
    assert.equal(rpcClient.calls.length, 0);
    assert.equal(pipeline.snapshot().metrics.logsIgnored, 1);
  });

  it('restores tracked markets from persisted pool registry rows', () => {
    const metadata = { quoteIndex: 1, quoteKind: 'erc20' };
    const pipeline = createRobinhoodOnchainPipeline({
      rpcClient: createRpc(),
      metadataReader: metadataReader(),
      quoteReader: { getSnapshot: async () => ({ priceUsd: '1', source: 'test' }) },
      seedPools: [{
        protocol: 'uniswap-v4',
        market_key: v4Fixture.expected.marketKey,
        pool_id: v4Fixture.expected.poolId,
        pool_address: null,
        origin_address: v4Fixture.poolManager,
        token_address: v4Fixture.expected.currency0,
        quote_address: v4Fixture.expected.currency1,
        currency0: v4Fixture.expected.currency0,
        currency1: v4Fixture.expected.currency1,
        fee: v4Fixture.expected.fee,
        tick_spacing: v4Fixture.expected.tickSpacing,
        metadata,
      }],
    });

    assert.deepEqual(pipeline.snapshot().tracked, { v2: 0, v3: 0, v4: 1 });
    assert.deepEqual(pipeline.getTrackedMarketAddresses(), [v4Fixture.poolManager]);
  });

  it('does not let a duplicate log alter window volume', async () => {
    const pipeline = createPipeline();
    await pipeline.processMarketLogs([v4Fixture.swap, { ...v4Fixture.swap }]);
    const snapshot = pipeline.snapshot();

    assert.equal(snapshot.metrics.swapsDecoded, 2);
    assert.equal(snapshot.metrics.swapsAccepted, 1);
    assert.equal(snapshot.windows.find((window) => window.window === '1m').volumeUsd, '0.7988');
  });

  it('removes an accepted observation when the poller reports a reorg', async () => {
    const pipeline = createPipeline();
    await pipeline.processMarketLogs([v4Fixture.swap]);

    assert.equal(pipeline.processRemovedLogs([{ ...v4Fixture.swap, removed: true }]), 1);
    assert.equal(pipeline.snapshot().metrics.observationsRemoved, 1);
    assert.deepEqual(pipeline.snapshot().windows, []);
  });

  it('does not retain rollback observations or analytical windows in persistent mode', async () => {
    const pipeline = createPipeline({
      retainRollbackState: false,
      windowAggregationEnabled: false,
    });

    const entries = await pipeline.processMarketRange([v4Fixture.swap]);
    const snapshot = pipeline.snapshot();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].observation.accepted, true);
    assert.deepEqual(snapshot.windows, []);
    assert.deepEqual(snapshot.inMemoryState, {
      rollbackEnabled: false,
      rollbackLimit: 0,
      observations: 0,
      discoveries: 0,
      windowAggregationEnabled: false,
      windowEvents: 0,
    });
    assert.equal(pipeline.processRemovedLogs([{ ...v4Fixture.swap, removed: true }]), 0);
  });

  it('bounds read-only rollback observations to the poller-compatible limit', async () => {
    const pipeline = createPipeline({ rollbackStateLimit: 2 });
    const swaps = Array.from({ length: 3 }, (_, index) => ({
      ...v4Fixture.swap,
      transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
      logIndex: `0x${(index + 9).toString(16)}`,
    }));

    await pipeline.processMarketLogs(swaps);

    assert.equal(pipeline.snapshot().inMemoryState.observations, 2);
    assert.equal(pipeline.snapshot().inMemoryState.windowEvents, 3);
    assert.equal(pipeline.processRemovedLogs([{ ...swaps[0], removed: true }]), 0);
    assert.equal(pipeline.processRemovedLogs([{ ...swaps[2], removed: true }]), 1);
    assert.equal(pipeline.snapshot().inMemoryState.observations, 1);
  });

  it('enriches missing block timestamps once per block', async () => {
    const rpcClient = createRpc();
    const pipeline = createPipeline({ rpcClient });
    const withoutTimestamp = { ...v4Fixture.swap, blockTimestamp: '0x0' };
    await pipeline.processMarketLogs([
      withoutTimestamp,
      { ...withoutTimestamp, logIndex: '0xa' },
    ]);

    assert.equal(rpcClient.calls.length, 1);
    assert.equal(rpcClient.calls[0].method, 'eth_getBlockByNumber');
    assert.equal(pipeline.snapshot().metrics.processingDelayMs.count, 2);
    assert.equal(pipeline.snapshot().enrichment.timestamps.blocksRequested, 1);
  });

  it('enriches metadata concurrently while preserving observation order', async () => {
    let active = 0;
    let maxActive = 0;
    const concurrentReader = {
      getMetadata: async (address) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return metadataReader().getMetadata(address);
      },
    };
    const pipeline = createPipeline({ metadataReader: concurrentReader, observationConcurrency: 2 });
    const secondSwap = {
      ...v4Fixture.swap,
      transactionHash: `0x${'cc'.repeat(32)}`,
      logIndex: '0x25',
    };
    const accepted = await pipeline.processMarketLogs([secondSwap, v4Fixture.swap]);

    assert.deepEqual(accepted.map((entry) => entry.logIndex), ['9', '37']);
    assert.equal(maxActive, 3);
    assert.equal(pipeline.snapshot().enrichment.observationConcurrency, 2);
  });

  it('uses exact historical supply and proves an unchanged isolated block failure', async () => {
    const supplyCalls = [];
    const reader = metadataReader();
    reader.getTotalSupply = async (_address, options) => {
      supplyCalls.push(options.blockTag);
      if (options.blockTag === v4Fixture.swap.blockNumber || options.blockTag === '0x729cd2') {
        return { usable: true, totalSupplyRaw: '1230000000000000000000' };
      }
      return { usable: false, totalSupplyRaw: null };
    };
    const secondSwap = {
      ...v4Fixture.swap,
      blockNumber: '0x729cd1',
      blockHash: `0x${'dd'.repeat(32)}`,
      blockTimestamp: '0x6a531556',
      transactionHash: `0x${'cc'.repeat(32)}`,
      logIndex: '0xa',
    };
    const pipeline = createPipeline({
      metadataReader: reader,
      supplyDeltaReader: { getDelta: async () => ({ usable: true, deltaRaw: '0' }) },
      observationConcurrency: 2,
    });

    const accepted = await pipeline.processMarketLogs([v4Fixture.swap, secondSwap]);

    assert.deepEqual(supplyCalls, ['0x729cd0', '0x729cd1', '0x729cd2']);
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].tokenSupplyStatus, 'exact_block_call');
    assert.equal(accepted[0].tokenSupplyBlockTag, '0x729cd0');
    assert.equal(accepted[1].tokenSupplyStatus, 'unchanged_between_anchors');
    assert.equal(accepted[1].tokenSupplyBlockTag, '0x729cd0');
    assert.equal(accepted[1].tokenTotalSupplyRaw, accepted[0].tokenTotalSupplyRaw);
    assert.equal(pipeline.snapshot().enrichment.supplyCheckpoints, 1);
  });

  it('reconstructs supply from mint and burn deltas after a historical call failure', async () => {
    const reader = metadataReader();
    reader.getTotalSupply = async (_address, options) => {
      if (options.blockTag === '0x729cd0') {
        return { usable: true, totalSupplyRaw: '1000' };
      }
      return options.blockTag === '0x729cd2'
        ? { usable: true, totalSupplyRaw: '900' }
        : { usable: false, totalSupplyRaw: null };
    };
    const secondSwap = {
      ...v4Fixture.swap,
      blockNumber: '0x729cd1',
      blockHash: `0x${'dd'.repeat(32)}`,
      blockTimestamp: '0x6a531556',
      transactionHash: `0x${'cc'.repeat(32)}`,
      logIndex: '0xa',
    };
    const ranges = [];
    const pipeline = createPipeline({
      metadataReader: reader,
      supplyDeltaReader: {
        getDelta: async (_address, range) => {
          ranges.push(range);
          return range.fromBlock === 0x729cd1n
            && range.toBlock === 0x729cd1n
            && ranges.length === 1
            ? { usable: true, deltaRaw: '-100' }
            : { usable: true, deltaRaw: '0' };
        },
      },
    });

    const accepted = await pipeline.processMarketLogs([v4Fixture.swap, secondSwap]);

    assert.equal(accepted.length, 2);
    assert.equal(accepted[1].tokenSupplyStatus, 'reconstructed_mint_burn');
    assert.equal(accepted[1].tokenSupplyBlockTag, '0x729cd0');
    assert.equal(accepted[1].tokenTotalSupplyRaw, '900');
    assert.deepEqual(ranges, [
      { fromBlock: 0x729cd1n, toBlock: 0x729cd1n },
      { fromBlock: 0x729cd2n, toBlock: 0x729cd2n },
    ]);
  });

  it('rejects reconstructed supply when mint and burn events disagree with the next anchor', async () => {
    const reader = metadataReader();
    reader.getTotalSupply = async (_address, options) => {
      if (options.blockTag === '0x729cd0') {
        return { usable: true, totalSupplyRaw: '1000' };
      }
      return options.blockTag === '0x729cd2'
        ? { usable: true, totalSupplyRaw: '800' }
        : { usable: false, totalSupplyRaw: null };
    };
    const secondSwap = {
      ...v4Fixture.swap,
      blockNumber: '0x729cd1',
      blockHash: `0x${'dd'.repeat(32)}`,
      blockTimestamp: '0x6a531556',
      transactionHash: `0x${'cc'.repeat(32)}`,
      logIndex: '0xa',
    };
    const pipeline = createPipeline({
      metadataReader: reader,
      supplyDeltaReader: {
        getDelta: async () => ({ usable: true, deltaRaw: '0' }),
      },
    });

    const entries = await pipeline.processMarketRange([v4Fixture.swap, secondSwap]);

    assert.equal(entries[0].observation.accepted, true);
    assert.equal(entries[1].observation.accepted, false);
    assert.equal(entries[1].observation.reason, 'token_metadata_unusable');
  });

  it('does not apply latest supply to history before the first reliable anchor', async () => {
    const reader = metadataReader();
    reader.getTotalSupply = async () => ({ usable: false, totalSupplyRaw: null });
    const pipeline = createPipeline({ metadataReader: reader });

    const [entry] = await pipeline.processMarketRange([v4Fixture.swap]);

    assert.equal(entry.observation.accepted, false);
    assert.equal(entry.observation.reason, 'token_metadata_unusable');
  });

  it('converts WETH swaps with a canonical quote cached by historical block', async () => {
    let quoteCalls = 0;
    const blockTags = [];
    const pipeline = createPipeline({
      now: Number(BigInt(v3Fixture.swap.blockTimestamp) * 1000n) + 1000,
      quoteReader: {
        getSnapshot: async (options) => {
          quoteCalls += 1;
          blockTags.push(options.blockTag);
          return { priceUsd: '1800', source: 'canonical-test' };
        },
      },
    });
    const accepted = await pipeline.processMarketLogs([v3Fixture.swap, {
      ...v3Fixture.swap,
      transactionHash: `0x${'cc'.repeat(32)}`,
      logIndex: '0x25',
    }]);

    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].quoteUsdSource, 'canonical-test');
    assert.equal(accepted[0].quoteUsdStatus, 'observed');
    assert.equal(quoteCalls, 1);
    assert.deepEqual(blockTags, [v3Fixture.swap.blockNumber]);
    assert.equal(pipeline.snapshot().enrichment.wethQuoteBlocks, 1);
  });

  it('counts quote and eligibility rejections without stalling the batch', async () => {
    const missingQuote = createPipeline({
      now: Number(BigInt(v3Fixture.swap.blockTimestamp) * 1000n) + 1000,
      quoteReader: { getSnapshot: async () => { throw new Error('quote unavailable'); } },
    });
    await missingQuote.processMarketLogs([v3Fixture.swap]);
    assert.equal(missingQuote.snapshot().metrics.missingQuote, 1);
    assert.equal(missingQuote.snapshot().metrics.withoutQuoteRate, 1);

    const denied = createPipeline({ policyOptions: { extraDenied: { TEST: v4Fixture.expected.currency0 } } });
    await denied.processMarketLogs([v4Fixture.swap]);
    assert.equal(denied.snapshot().metrics.eligibilityRejected, 1);
    assert.equal(denied.snapshot().metrics.swapsRejected, 1);
  });

  it('processes discoveries in block/log order even when RPC input is shuffled', async () => {
    const pipeline = createPipeline();
    await pipeline.processDiscoveryLogs([v4Fixture.initialize, v3Fixture.poolCreated, v2Fixture.pairCreated]);
    const snapshot = pipeline.snapshot();

    assert.equal(snapshot.metrics.discoveries, 3);
    assert.equal(snapshot.metrics.protocols['uniswap-v2'].discoveries, 1);
    assert.equal(snapshot.metrics.protocols['uniswap-v3'].discoveries, 1);
    assert.equal(snapshot.metrics.protocols['uniswap-v4'].discoveries, 1);
    assert.equal(sortLogs([v4Fixture.swap, v4Fixture.initialize])[0].logIndex, v4Fixture.initialize.logIndex);
  });

  it('validates NOXA after seeding v3 discoveries without creating another market', async () => {
    let validatedPool = null;
    const noxaLog = { ...noxaFixture.tokenLaunched, logIndex: '0x0' };
    const poolLog = { ...v3Fixture.poolCreated, logIndex: '0x1' };
    const pipeline = createRobinhoodOnchainPipeline({
      rpcClient: createRpc(),
      metadataReader: metadataReader(),
      quoteReader: { getSnapshot: async () => ({ priceUsd: '1', source: 'test' }) },
      noxaValidator: {
        validateOnchain: async (launch, context) => {
          validatedPool = context.v3Pool;
          return {
            ...launch,
            accepted: true,
            validationErrors: [],
            factoryRecord: { supplyRaw: noxaFixture.expected.supply },
            marketDiscoveryKey: `robinhood:uniswap-v3:${launch.poolAddress}`,
            isNewMarket: false,
            deduplicatedWith: 'uniswap-v3',
          };
        },
      },
    });

    const entries = await pipeline.processDiscoveryRange([noxaLog, poolLog]);
    const snapshot = pipeline.snapshot();

    assert.equal(validatedPool.poolAddress, noxaFixture.expected.pool);
    assert.equal(entries[0].event.kind, 'token-launched');
    assert.equal(entries[0].event.protocol, 'uniswap-v3');
    assert.equal(entries[0].event.marketKey, `robinhood:uniswap-v3:${noxaFixture.expected.pool}`);
    assert.equal(entries[1].event.kind, 'pool-created');
    assert.deepEqual(snapshot.tracked, { v2: 0, v3: 1, v4: 0 });
    assert.deepEqual(snapshot.metrics.noxa, { seen: 1, accepted: 1, rejected: 0 });
  });

  it('removes reorged discoveries from each protocol registry', async () => {
    const pipeline = createPipeline();
    const discoveries = [v2Fixture.pairCreated, v3Fixture.poolCreated, v4Fixture.initialize];
    await pipeline.processDiscoveryLogs(discoveries);

    assert.equal(pipeline.processRemovedDiscoveryLogs(discoveries), 3);
    assert.deepEqual(pipeline.snapshot().tracked, { v2: 0, v3: 0, v4: 0 });
    assert.equal(pipeline.snapshot().metrics.discoveriesRemoved, 3);
  });

  it('queues discovered token metadata without awaiting DexScreener', async () => {
    const addresses = new Set();
    const socialMetadataQueue = {
      enqueue: (address) => {
        const size = addresses.size;
        addresses.add(address);
        return addresses.size > size;
      },
      snapshot: () => ({ enabled: true, queued: addresses.size }),
    };
    const pipeline = createPipeline({ socialMetadataQueue });
    await pipeline.processDiscoveryLogs([v2Fixture.pairCreated, v3Fixture.poolCreated, v4Fixture.initialize]);
    const snapshot = pipeline.snapshot();

    assert.equal(addresses.size, 3);
    assert.equal(snapshot.metrics.socialMetadataQueued, 3);
    assert.deepEqual(snapshot.socialMetadata, { enabled: true, queued: 3 });
  });
});
