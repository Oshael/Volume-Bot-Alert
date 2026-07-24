const {
  FIELDS,
  MULTICALL3_ADDRESS,
  SELECTORS,
  encodeAggregate3,
} = require('./evm-erc20-metadata');
const {
  classifyTokenEligibility,
} = require('./robinhood-market-policy');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

function blockTag(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error('claim.blockNumber must be a non-negative integer');
  }
  return `0x${BigInt(raw).toString(16)}`;
}

function provider(value, label) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 64) throw new Error(`${label} is invalid`);
  return normalized;
}

function parseMetadata(row) {
  if (typeof row.metadata !== 'string') return row.metadata || {};
  try {
    return JSON.parse(row.metadata);
  } catch (_) {
    throw new Error(`Pool ${rowValue(row, 'market_key', 'marketKey')} has invalid metadata`);
  }
}

function rowValue(row, databaseKey, objectKey) {
  return row[databaseKey] ?? row[objectKey];
}

function catalogSeeds(rows = []) {
  const seeds = { v2: [], v3: [], v4: [] };
  for (const row of rows) {
    const protocol = String(row.protocol || '');
    const metadata = parseMetadata(row);
    const quoteIndex = Number(metadata.quoteIndex);
    if (![0, 1].includes(quoteIndex)) {
      throw new Error(
        `Pool ${rowValue(row, 'market_key', 'marketKey')} has invalid quoteIndex`
      );
    }
    const common = {
      marketKey: rowValue(row, 'market_key', 'marketKey'),
      tokenAddress: rowValue(row, 'token_address', 'tokenAddress'),
      quoteAddress: rowValue(row, 'quote_address', 'quoteAddress'),
      quoteIndex,
      token0: row.currency0,
      token1: row.currency1,
      currency0: row.currency0,
      currency1: row.currency1,
      fee: row.fee == null ? null : Number(row.fee),
      tickSpacing: row.tick_spacing == null ? null : Number(row.tick_spacing),
    };
    if (protocol === 'uniswap-v2') {
      seeds.v2.push({ ...common, pairAddress: rowValue(row, 'pool_address', 'poolAddress') });
    } else if (protocol === 'uniswap-v3') {
      seeds.v3.push({ ...common, poolAddress: rowValue(row, 'pool_address', 'poolAddress') });
    } else if (protocol === 'uniswap-v4') {
      seeds.v4.push({
        ...common,
        poolId: rowValue(row, 'pool_id', 'poolId'),
        poolManagerAddress: rowValue(row, 'origin_address', 'originAddress'),
        quoteCurrencyAddress: quoteIndex === 0
          ? row.currency0
          : row.currency1,
        quoteKind: metadata.quoteKind,
      });
    } else {
      throw new Error(`Unsupported catalog protocol: ${protocol || 'missing'}`);
    }
  }
  return seeds;
}

function rawLog(claim) {
  return {
    address: claim.address,
    topics: claim.topics,
    data: claim.data,
    blockNumber: claim.blockNumber,
    blockHash: claim.blockHash,
    transactionHash: claim.transactionHash,
    transactionIndex: claim.transactionIndex,
    logIndex: claim.logIndex,
  };
}

function metadataData(address) {
  return encodeAggregate3(FIELDS.map((field) => ({
    target: address,
    allowFailure: true,
    callData: SELECTORS[field],
  })));
}

function request(slot, method, params, routedProvider) {
  return { slot, provider: routedProvider, method, params };
}

function createRobinhoodBackfillEnrichmentPreparer(options = {}) {
  const seeds = catalogSeeds(options.seedPools);
  const trackers = {
    'uniswap-v2': v2.createUniswapV2Tracker({ seedPairs: seeds.v2 }),
    'uniswap-v3': v3.createUniswapV3Tracker({ seedPools: seeds.v3 }),
    'uniswap-v4': v4.createUniswapV4Tracker({ seedPools: seeds.v4 }),
  };
  const rpcProvider = provider(options.rpcProvider, 'rpcProvider');
  const timestampProvider = provider(
    options.timestampProvider ?? rpcProvider,
    'timestampProvider'
  );

  function prepareClaim(claim) {
    const protocol = String(claim?.protocol || '');
    const tracker = trackers[protocol];
    if (!tracker) throw new Error(`Unsupported claim protocol: ${protocol || 'missing'}`);
    const log = rawLog(claim);
    const event = tracker.processLog(log);
    if (!event || event.kind === 'ignored') {
      throw new Error(`Claim could not be decoded: ${event?.reason || 'missing event'}`);
    }
    const marketKey = String(claim.marketKey || '').toLowerCase();
    if (!marketKey || event.marketKey !== marketKey) {
      throw new Error('Decoded event does not match claim.marketKey');
    }
    const resolvedBlockTag = blockTag(claim.blockNumber);
    const requests = [
      request(
        'block',
        'eth_getBlockByNumber',
        [resolvedBlockTag, false],
        timestampProvider
      ),
    ];
    const eligibility = event.kind === 'swap'
      ? classifyTokenEligibility(event.tokenAddress, options.policyOptions)
      : null;
    if (event.kind === 'swap' && event.accepted === true && eligibility.eligible) {
      requests.push(
        request(
          'tokenMetadata',
          'eth_call',
          [{ to: MULTICALL3_ADDRESS, data: metadataData(event.tokenAddress) }, resolvedBlockTag],
          rpcProvider
        ),
        request(
          'quoteMetadata',
          'eth_call',
          [{ to: MULTICALL3_ADDRESS, data: metadataData(event.quoteAddress) }, 'latest'],
          rpcProvider
        )
      );
    }
    return {
      tokenAddress: event.tokenAddress,
      requests,
      context: {
        log,
        event,
        eligibility,
        blockTag: resolvedBlockTag,
        needsWethQuote: event.kind === 'swap' && event.quoteAddress === v2.ROBINHOOD_WETH,
      },
    };
  }

  return Object.freeze({ prepareClaim });
}

module.exports = {
  createRobinhoodBackfillEnrichmentPreparer,
  __private: { blockTag, catalogSeeds },
};
