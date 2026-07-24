const {
  FIELDS,
  decodeAggregate3,
  decodeMetadataResults,
} = require('./evm-erc20-metadata');
const { validTimestamp } = require('./evm-log-enrichment');
const {
  buildMarketObservation,
} = require('./evm-market-metrics');
const {
  createRobinhoodBackfillEnrichmentPreparer,
} = require('./robinhood-backfill-enrichment-preparer');
const {
  buildLiquidityAssessment,
} = require('./robinhood-market-policy');
const {
  createRobinhoodWethUsdQuoteReader,
} = require('./robinhood-weth-usd-quote');

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(raw);
}

function normalizedHash(value, label) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} must be 32 bytes`);
  return hash;
}

function enrichBlockContext(context, block) {
  if (quantity(block?.number, 'block.number') !== quantity(context.blockTag, 'blockTag')) {
    throw new Error('Enrichment block number does not match the claimed log');
  }
  if (
    normalizedHash(block?.hash, 'block.hash')
    !== normalizedHash(context.log.blockHash, 'claim.blockHash')
  ) {
    const error = new Error('Enrichment block hash does not match the captured log');
    error.code = 'backfill_reorg_detected';
    throw error;
  }
  if (!validTimestamp(block?.timestamp)) {
    throw new Error('Enrichment block timestamp is invalid');
  }
  const timestampMs = (quantity(block.timestamp, 'block.timestamp') * 1000n).toString();
  return {
    log: { ...context.log, blockTimestamp: String(block.timestamp) },
    event: { ...context.event, timestampMs },
  };
}

function metadataFromResult(address, result) {
  return decodeMetadataResults(
    address,
    decodeAggregate3(result, FIELDS.length)
  );
}

function tokenMetadata(context, results) {
  const metadata = metadataFromResult(context.event.tokenAddress, results.tokenMetadata);
  return {
    ...metadata,
    tokenSupplyStatus: metadata.usable ? 'exact_block_call' : 'unavailable',
    tokenSupplyBlockTag: context.blockTag,
  };
}

function addLiquidity(observation, event, quoteMetadata) {
  if (!observation.accepted) return observation;
  const liquidity = buildLiquidityAssessment({
    protocol: event.protocol,
    quoteReserveRaw: event.quoteReserveRaw,
    quoteDecimals: quoteMetadata.decimals,
    quoteUsdPrice: observation.quoteUsdPrice,
    liquidityRaw: event.liquidityRaw,
  });
  return {
    ...observation,
    liquidityUsd: liquidity.liquidityUsd,
    liquidityRaw: liquidity.liquidityRaw ?? null,
    liquidityStatus: liquidity.status,
    liquidityConfidence: liquidity.confidence,
    liquidityWarning: liquidity.warning ?? null,
  };
}

function createRobinhoodBackfillEnrichmentAdapter(options = {}) {
  const preparer = options.preparer
    || createRobinhoodBackfillEnrichmentPreparer(options);
  const quoteReader = options.quoteReader
    || (options.rpcClient
      ? createRobinhoodWethUsdQuoteReader({ rpcClient: options.rpcClient })
      : null);

  async function buildEntry({ context, results }) {
    const enriched = enrichBlockContext(context, results.block);
    const event = enriched.event;
    if (event.kind !== 'swap') return { log: enriched.log, event };
    let wethQuote = null;
    if (context.needsWethQuote) {
      if (!quoteReader) throw new Error('WETH quote reader is required for WETH markets');
      try {
        wethQuote = await quoteReader.getSnapshot({ blockTag: context.blockTag });
      } catch (error) {
        if (error?.retryable === true) throw error;
      }
    }
    const hasMetadata = event.accepted === true && context.eligibility?.eligible === true;
    const resolvedTokenMetadata = hasMetadata
      ? tokenMetadata(context, results)
      : null;
    const quoteMetadata = hasMetadata
      ? metadataFromResult(event.quoteAddress, results.quoteMetadata)
      : null;
    const observation = buildMarketObservation({
      swap: event,
      eligibility: context.eligibility,
      tokenMetadata: resolvedTokenMetadata,
      quoteMetadata,
      ...(wethQuote ? {
        wethUsdPrice: wethQuote.priceUsd,
        wethUsdSource: wethQuote.source,
      } : {}),
    });
    return {
      log: enriched.log,
      event,
      observation: addLiquidity(observation, event, quoteMetadata),
    };
  }

  return Object.freeze({
    prepareClaim: preparer.prepareClaim,
    buildEntry,
  });
}

module.exports = {
  createRobinhoodBackfillEnrichmentAdapter,
  __private: { enrichBlockContext, metadataFromResult },
};
