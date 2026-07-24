const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const v2Fixture = require('../data/fixtures/robinhood-uniswap-v2.json');
const v3Fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const v4Fixture = require('../data/fixtures/robinhood-uniswap-v4.json');
const {
  AGGREGATE3_SELECTOR,
  MULTICALL3_ADDRESS,
} = require('../src/services/evm-erc20-metadata');
const {
  createRobinhoodBackfillEnrichmentPreparer,
} = require('../src/services/robinhood-backfill-enrichment-preparer');

const DETAILS = {
  v2: {
    marketKey: `robinhood:uniswap-v2:${v2Fixture.expected.pair}`,
    token: v2Fixture.expected.token1,
    quote: v2Fixture.expected.token0,
    quoteIndex: 0,
  },
  v3: {
    marketKey: `robinhood:uniswap-v3:${v3Fixture.expected.pool}`,
    token: v3Fixture.expected.token1,
    quote: v3Fixture.expected.token0,
    quoteIndex: 0,
  },
  v4: {
    marketKey: `robinhood:uniswap-v4:${v4Fixture.expected.poolId}`,
    token: v4Fixture.expected.currency0,
    quote: v4Fixture.expected.currency1,
    quoteIndex: 1,
  },
};

function decimal(value) {
  return BigInt(value).toString();
}

function claim(log, protocol, marketKey) {
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
    marketKey,
  };
}

function seedPools() {
  return [{
    protocol: 'uniswap-v2',
    market_key: DETAILS.v2.marketKey,
    pool_address: v2Fixture.expected.pair,
    token_address: DETAILS.v2.token,
    quote_address: DETAILS.v2.quote,
    currency0: v2Fixture.expected.token0,
    currency1: v2Fixture.expected.token1,
    metadata: { quoteIndex: DETAILS.v2.quoteIndex },
  }, {
    protocol: 'uniswap-v3',
    market_key: DETAILS.v3.marketKey,
    pool_address: v3Fixture.expected.pool,
    token_address: DETAILS.v3.token,
    quote_address: DETAILS.v3.quote,
    currency0: v3Fixture.expected.token0,
    currency1: v3Fixture.expected.token1,
    fee: v3Fixture.expected.fee,
    metadata: { quoteIndex: DETAILS.v3.quoteIndex },
  }, {
    protocol: 'uniswap-v4',
    market_key: DETAILS.v4.marketKey,
    pool_id: v4Fixture.expected.poolId,
    origin_address: v4Fixture.poolManager,
    token_address: DETAILS.v4.token,
    quote_address: DETAILS.v4.quote,
    currency0: v4Fixture.expected.currency0,
    currency1: v4Fixture.expected.currency1,
    fee: v4Fixture.expected.fee,
    tick_spacing: v4Fixture.expected.tickSpacing,
    metadata: {
      quoteIndex: DETAILS.v4.quoteIndex,
      quoteKind: 'erc20',
    },
  }];
}

function assertMetadataRequest(dependency, address, blockTag) {
  assert.equal(dependency.method, 'eth_call');
  assert.equal(dependency.params[0].to, MULTICALL3_ADDRESS);
  assert.equal(dependency.params[0].data.startsWith(AGGREGATE3_SELECTOR), true);
  assert.equal(dependency.params[0].data.includes(address.slice(2)), true);
  assert.equal(dependency.params[1], blockTag);
}

describe('Robinhood backfill enrichment preparer', () => {
  it('decodes V2 state in claim order and plans historical metadata', () => {
    const preparer = createRobinhoodBackfillEnrichmentPreparer({
      seedPools: seedPools(),
    });
    const sync = preparer.prepareClaim(claim(
      v2Fixture.sync,
      'uniswap-v2',
      DETAILS.v2.marketKey
    ));
    const swap = preparer.prepareClaim(claim(
      v2Fixture.swap,
      'uniswap-v2',
      DETAILS.v2.marketKey
    ));

    assert.equal(sync.context.event.kind, 'sync');
    assert.deepEqual(sync.requests.map(({ slot }) => slot), ['block']);
    assert.equal(swap.context.event.kind, 'swap');
    assert.equal(
      swap.context.event.quoteReserveRaw,
      sync.context.event.quoteReserveRaw
    );
    assert.deepEqual(
      swap.requests.map(({ slot }) => slot),
      ['block', 'tokenMetadata', 'quoteMetadata']
    );
    assertMetadataRequest(
      swap.requests[1],
      DETAILS.v2.token,
      `0x${BigInt(v2Fixture.swap.blockNumber).toString(16)}`
    );
    assertMetadataRequest(swap.requests[2], DETAILS.v2.quote, 'latest');
    assert.ok(swap.requests.every((dependency) => dependency.provider === null));
  });

  it('uses the existing seeded decoders for V3 and V4 claims', () => {
    const preparer = createRobinhoodBackfillEnrichmentPreparer({
      seedPools: seedPools(),
    });
    const cases = [
      [v3Fixture, 'uniswap-v3', DETAILS.v3],
      [v4Fixture, 'uniswap-v4', DETAILS.v4],
    ];
    for (const [fixture, protocol, details] of cases) {
      const prepared = preparer.prepareClaim(claim(
        fixture.swap,
        protocol,
        details.marketKey
      ));
      assert.equal(prepared.context.event.kind, 'swap');
      assert.equal(prepared.context.event.protocol, protocol);
      assert.equal(prepared.context.event.marketKey, details.marketKey);
      assert.equal(prepared.requests.length, 3);
    }
  });

  it('routes only timestamps to Alchemy when explicitly configured', () => {
    const preparer = createRobinhoodBackfillEnrichmentPreparer({
      seedPools: seedPools(),
      timestampProvider: 'alchemy-free',
    });
    const prepared = preparer.prepareClaim(claim(
      v3Fixture.swap,
      'uniswap-v3',
      DETAILS.v3.marketKey
    ));

    assert.equal(prepared.requests[0].provider, 'alchemy-free');
    assert.equal(prepared.requests[1].provider, null);
    assert.equal(prepared.requests[2].provider, null);
  });

  it('skips metadata RPC for a denied token but preserves terminal context', () => {
    const preparer = createRobinhoodBackfillEnrichmentPreparer({
      seedPools: seedPools(),
      policyOptions: { extraDenied: { TEST: DETAILS.v4.token } },
    });
    const prepared = preparer.prepareClaim(claim(
      v4Fixture.swap,
      'uniswap-v4',
      DETAILS.v4.marketKey
    ));

    assert.deepEqual(prepared.requests.map(({ slot }) => slot), ['block']);
    assert.equal(prepared.context.eligibility.eligible, false);
    assert.equal(prepared.context.eligibility.reason, 'configured_denylist');
  });

  it('fails closed for missing catalog state and market identity drift', () => {
    assert.throws(
      () => createRobinhoodBackfillEnrichmentPreparer({
        seedPools: [{ ...seedPools()[1], metadata: {} }],
      }),
      /invalid quoteIndex/
    );
    const empty = createRobinhoodBackfillEnrichmentPreparer({ seedPools: [] });
    assert.throws(
      () => empty.prepareClaim(claim(
        v3Fixture.swap,
        'uniswap-v3',
        DETAILS.v3.marketKey
      )),
      /unknown_pool/
    );
    const seeded = createRobinhoodBackfillEnrichmentPreparer({
      seedPools: seedPools(),
    });
    assert.throws(
      () => seeded.prepareClaim(claim(
        v4Fixture.swap,
        'uniswap-v4',
        'robinhood:uniswap-v4:wrong'
      )),
      /does not match/
    );
  });
});
