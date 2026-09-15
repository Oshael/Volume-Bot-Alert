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

function primedRangeLookup(ranges, claim) {
  if (!claim) return { found: false, value: null };
  const key = `${claim.transactionHash}:${claim.logIndex}`;
  return { found: ranges.has(key), value: ranges.get(key) };
}

async function addLiquidity(
  observation, event, quoteMetadata, v4LiquidityReader, primedRanges, hasPrimedRanges
) {
  if (!observation.accepted) return observation;
  const v4Ranges = event.protocol === 'uniswap-v4' && v4LiquidityReader
    ? hasPrimedRanges
      ? primedRanges
      : await v4LiquidityReader.listHistoricalV4LiquidityRanges(
        event.poolId, event.blockNumber, event.logIndex
      )
    : null;
  const liquidity = buildLiquidityAssessment({
    protocol: event.protocol,
    quoteReserveRaw: event.quoteReserveRaw,
    quoteDecimals: quoteMetadata.decimals,
    quoteUsdPrice: observation.quoteUsdPrice,
    tokenBalanceRaw: event.protocol === 'uniswap-v3' ? quantity(event.tokenBalanceRaw, 'tokenBalanceRaw') : null,
    quoteBalanceRaw: event.protocol === 'uniswap-v3' ? quantity(event.quoteBalanceRaw, 'quoteBalanceRaw') : null,
    tokenDecimals: observation.tokenDecimals,
    tokenUsdPrice: observation.priceUsd,
    liquidityRaw: event.liquidityRaw,
    sqrtPriceX96: event.sqrtPriceX96,
    quoteIndex: event.quoteIndex,
    v4Ranges,
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
  const stockQuoteReader = options.stockQuoteReader || null;
  const v4LiquidityReader = options.v4LiquidityReader || null;
  let primedV4Ranges = new Map();

  async function primeEntries(prepared) {
    primedV4Ranges = new Map();
    if (typeof v4LiquidityReader?.listHistoricalV4LiquidityRangesAtPositions !== 'function') {
      return;
    }
    const positions = prepared
      .filter(({ context }) => (
        context?.event?.kind === 'swap' && context.event.protocol === 'uniswap-v4'
      ))
      .map(({ item, context }) => ({
        id: item.id,
        poolId: context.event.poolId,
        blockNumber: context.event.blockNumber,
        logIndex: context.event.logIndex,
      }));
    primedV4Ranges = await v4LiquidityReader
      .listHistoricalV4LiquidityRangesAtPositions(positions);
  }

  async function buildEntry({ claim, context, results }) {
    const enriched = enrichBlockContext(context, results.block);
    const event = enriched.event;
    if (event.kind !== 'swap') return { log: enriched.log, event };
    const hasMetadata = event.accepted === true && context.eligibility?.eligible === true;
    let wethQuote = null;
    if (hasMetadata && context.needsWethQuote) {
      if (!quoteReader) throw new Error('WETH quote reader is required for WETH markets');
      try {
        wethQuote = await quoteReader.getSnapshot({ blockTag: context.blockTag });
      } catch (error) {
        if (error?.retryable === true) throw error;
      }
    }
    let stockQuote = null;
    if (hasMetadata && context.needsStockQuote) {
      if (!stockQuoteReader) throw new Error('Stock quote reader is required for stock markets');
      stockQuote = await stockQuoteReader.getSnapshot({
        stockAddress: event.quoteAddress, blockTag: context.blockTag,
      });
    }
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
      ...(stockQuote ? {
        quoteUsdAddress: stockQuote.stockAddress,
        quoteUsdPrice: stockQuote.priceUsd,
        quoteUsdSource: stockQuote.source,
        quoteUsdStatus: stockQuote.status,
      } : {}),
    });
    if (event.protocol === 'uniswap-v3' && hasMetadata) {
      event.tokenBalanceRaw = quantity(results.tokenBalance, 'tokenBalance').toString();
      event.quoteBalanceRaw = quantity(results.quoteBalance, 'quoteBalance').toString();
    }
    const primed = primedRangeLookup(primedV4Ranges, claim);
    return {
      log: enriched.log,
      event,
      observation: await addLiquidity(
        observation,
        event,
        quoteMetadata,
        v4LiquidityReader,
        primed.value,
        primed.found
      ),
    };
  }

  return Object.freeze({
    prepareClaim: preparer.prepareClaim,
    primeEntries,
    buildEntry,
  });
}

module.exports = {
  createRobinhoodBackfillEnrichmentAdapter,
  __private: { enrichBlockContext, metadataFromResult },
};
