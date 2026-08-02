const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const v3Fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const v4Fixture = require('../data/fixtures/robinhood-uniswap-v4.json');
const {
  createRobinhoodBackfillEnrichmentAdapter,
} = require('../src/services/robinhood-backfill-enrichment-adapter');

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

function aggregateResult({ symbol, decimals, supply, failSupply = false }) {
  const results = [
    { success: true, returnData: stringResult(`${symbol} Token`) },
    {
      success: true,
      returnData: `0x${Buffer.from(symbol).toString('hex').padEnd(64, '0')}`,
    },
    { success: true, returnData: `0x${word(decimals)}` },
    { success: !failSupply, returnData: `0x${word(supply)}` },
  ];
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

function decimal(value) {
  return BigInt(value).toString();
}

function marketDetails(fixture, protocol) {
  if (protocol === 'uniswap-v3') {
    return {
      marketKey: `robinhood:uniswap-v3:${fixture.expected.pool}`,
      token: fixture.expected.token1,
      quote: fixture.expected.token0,
      quoteIndex: 0,
    };
  }
  return {
    marketKey: `robinhood:uniswap-v4:${fixture.expected.poolId}`,
    token: fixture.expected.currency0,
    quote: fixture.expected.currency1,
    quoteIndex: 1,
  };
}

function seed(fixture, protocol) {
  const details = marketDetails(fixture, protocol);
  return {
    protocol,
    market_key: details.marketKey,
    pool_address: protocol === 'uniswap-v3' ? fixture.expected.pool : null,
    pool_id: protocol === 'uniswap-v4' ? fixture.expected.poolId : null,
    origin_address: protocol === 'uniswap-v4' ? fixture.poolManager : null,
    token_address: details.token,
    quote_address: details.quote,
    currency0: fixture.expected.token0 || fixture.expected.currency0,
    currency1: fixture.expected.token1 || fixture.expected.currency1,
    fee: fixture.expected.fee,
    tick_spacing: fixture.expected.tickSpacing,
    metadata: { quoteIndex: details.quoteIndex, quoteKind: 'erc20' },
  };
}

function claim(fixture, protocol, log = fixture.swap) {
  return {
    transactionHash: log.transactionHash,
    logIndex: decimal(log.logIndex),
    blockNumber: decimal(log.blockNumber),
    blockHash: log.blockHash,
    transactionIndex: decimal(log.transactionIndex || 0),
    address: log.address,
    topics: log.topics,
    data: log.data,
    protocol,
    marketKey: marketDetails(fixture, protocol).marketKey,
  };
}

function resultsFor(prepared, overrides = {}) {
  return {
    block: {
      number: prepared.context.blockTag,
      hash: prepared.context.log.blockHash,
      timestamp: overrides.timestamp || '0x65',
    },
    tokenMetadata: overrides.tokenMetadata || aggregateResult({
      symbol: 'MEME',
      decimals: 18,
      supply: 10n ** 27n,
    }),
    quoteMetadata: overrides.quoteMetadata || aggregateResult({
      symbol: 'USDG',
      decimals: 6,
      supply: 10n ** 15n,
    }),
    tokenBalance: overrides.tokenBalance || `0x${word(10n * 10n ** 18n)}`,
    quoteBalance: overrides.quoteBalance || `0x${word(2n * 10n ** 18n)}`,
  };
}

describe('Robinhood backfill enrichment adapter', () => {
  it('materializes an exact historical USDG observation and liquidity contract', async () => {
    const reads = [];
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v4Fixture, 'uniswap-v4')],
      v4LiquidityReader: {
        async listHistoricalV4LiquidityRanges(...args) {
          reads.push(args);
          return [{ tick_lower: -887000, tick_upper: 887000, liquidity_gross: '1000000000000000000' }];
        },
      },
    });
    const prepared = adapter.prepareClaim(claim(v4Fixture, 'uniswap-v4'));
    const entry = await adapter.buildEntry({
      context: prepared.context,
      results: resultsFor(prepared),
    });

    assert.equal(entry.event.timestampMs, '101000');
    assert.equal(entry.log.blockTimestamp, '0x65');
    assert.equal(entry.observation.accepted, true);
    assert.equal(entry.observation.tokenSupplyStatus, 'exact_block_call');
    assert.equal(entry.observation.tokenSupplyBlockTag, prepared.context.blockTag);
    assert.equal(entry.observation.quoteUsdPrice, '1');
    assert.equal(entry.observation.quoteUsdSource, 'usdg-peg-assumption');
    assert.equal(entry.observation.liquidityStatus, 'spot_tvl_from_v4_tick_ranges');
    assert.ok(Number(entry.observation.liquidityUsd) > 0);
    assert.equal(entry.observation.liquidityRaw, v4Fixture.expected.liquidity);
    assert.deepEqual(reads, [[
      v4Fixture.expected.poolId,
      BigInt(v4Fixture.swap.blockNumber).toString(),
      BigInt(v4Fixture.swap.logIndex).toString(),
    ]]);
  });

  it('uses the canonical historical WETH quote reader without routing it to Alchemy', async () => {
    const calls = [];
    const quoteReader = {
      async getSnapshot(input) {
        calls.push(input);
        return {
          priceUsd: '1800',
          source: 'canonical-uniswap-v3-weth-usdg-100',
        };
      },
    };
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v3Fixture, 'uniswap-v3')],
      quoteReader,
    });
    const prepared = adapter.prepareClaim(claim(v3Fixture, 'uniswap-v3'));
    const entry = await adapter.buildEntry({
      context: prepared.context,
      results: resultsFor(prepared, {
        quoteMetadata: aggregateResult({
          symbol: 'WETH',
          decimals: 18,
          supply: 10n ** 27n,
        }),
      }),
    });

    assert.deepEqual(calls, [{ blockTag: prepared.context.blockTag }]);
    assert.equal(entry.observation.accepted, true);
    assert.equal(entry.observation.quoteUsdPrice, '1800');
    assert.equal(
      entry.observation.quoteUsdSource,
      'canonical-uniswap-v3-weth-usdg-100'
    );
    assert.equal(entry.observation.liquidityStatus, 'spot_tvl_from_pool_balances');
  });

  it('keeps policy rejection terminal without decoding absent metadata', async () => {
    const details = marketDetails(v4Fixture, 'uniswap-v4');
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v4Fixture, 'uniswap-v4')],
      policyOptions: { extraDenied: { TEST: details.token } },
    });
    const prepared = adapter.prepareClaim(claim(v4Fixture, 'uniswap-v4'));
    const entry = await adapter.buildEntry({
      context: prepared.context,
      results: {
        block: resultsFor(prepared).block,
      },
    });

    assert.equal(entry.observation.accepted, false);
    assert.equal(entry.observation.reason, 'token_ineligible');
  });

  it('materializes state logs without inventing a market observation', async () => {
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v3Fixture, 'uniswap-v3')],
    });
    const prepared = adapter.prepareClaim(claim(
      v3Fixture,
      'uniswap-v3',
      v3Fixture.initialize
    ));
    const entry = await adapter.buildEntry({
      context: prepared.context,
      results: { block: resultsFor(prepared).block },
    });

    assert.equal(entry.event.kind, 'initialize');
    assert.equal(Object.hasOwn(entry, 'observation'), false);
  });

  it('propagates a transient canonical WETH quote failure for retry', async () => {
    const failure = Object.assign(new Error('quote timeout'), { retryable: true });
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v3Fixture, 'uniswap-v3')],
      quoteReader: { getSnapshot: async () => { throw failure; } },
    });
    const prepared = adapter.prepareClaim(claim(v3Fixture, 'uniswap-v3'));

    await assert.rejects(
      adapter.buildEntry({ context: prepared.context, results: resultsFor(prepared) }),
      (error) => error === failure
    );
  });

  it('leaves unusable historical supply recoverable for the worker', async () => {
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v4Fixture, 'uniswap-v4')],
    });
    const prepared = adapter.prepareClaim(claim(v4Fixture, 'uniswap-v4'));
    const unusable = aggregateResult({
      symbol: 'MEME',
      decimals: 18,
      supply: 10n ** 27n,
      failSupply: true,
    });
    const entry = await adapter.buildEntry({
      context: prepared.context,
      results: resultsFor(prepared, { tokenMetadata: unusable }),
    });

    assert.equal(entry.observation.accepted, false);
    assert.equal(entry.observation.reason, 'token_metadata_unusable');
  });

  it('fails closed when the fetched block no longer matches the capture', async () => {
    const adapter = createRobinhoodBackfillEnrichmentAdapter({
      seedPools: [seed(v4Fixture, 'uniswap-v4')],
    });
    const prepared = adapter.prepareClaim(claim(v4Fixture, 'uniswap-v4'));
    const results = resultsFor(prepared);
    results.block.hash = `0x${'f'.repeat(64)}`;

    await assert.rejects(
      adapter.buildEntry({ context: prepared.context, results }),
      (error) => error.code === 'backfill_reorg_detected'
    );
  });
});
