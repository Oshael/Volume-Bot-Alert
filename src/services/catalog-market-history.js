const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const config = require('../../config');
const {
  createRobinhoodMarketHistoryReadRepository,
} = require('../models/robinhood-market-history-read');
const { createTokenIdentity } = require('../utils/token-identity');
const {
  ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES,
  MAX_COMPACT_SPARKLINE_POINTS,
} = require('../utils/market-bucket-granularities');

const SUPPORTED_CHAINS = new Set(['solana', 'robinhood']);
const MINUTE_MS = 60_000;

function normalizeRequest(input = {}) {
  const identity = createTokenIdentity(input.chain || 'solana', input.address);
  if (!SUPPORTED_CHAINS.has(identity.chain)) {
    throw new Error(`Expanded market history is unavailable for ${identity.chain}`);
  }
  return {
    ...identity,
    points: Number(input.points) || 720,
    granularityMinutes: input.granularityMinutes == null
      ? null
      : Number(input.granularityMinutes),
    allowOneMinuteFallback: input.allowOneMinuteFallback === true,
  };
}

function normalizeBatchRequest(input = {}) {
  if (!Array.isArray(input.identities) || !input.identities.length) {
    throw new Error('Market history identities are required');
  }
  const byKey = new Map();
  for (const value of input.identities) {
    const identity = createTokenIdentity(value?.chain, value?.address);
    if (!SUPPORTED_CHAINS.has(identity.chain)) {
      throw new Error(`Market history is unavailable for ${identity.chain}`);
    }
    byKey.set(identity.key, identity);
  }
  const identities = [...byKey.values()];
  const robinhoodCount = identities.filter((identity) => identity.chain === 'robinhood').length;
  if (identities.length > 500 || robinhoodCount > 100) {
    throw new Error('Market history accepts at most 500 identities and 100 Robinhood identities');
  }
  const allAvailable = input.allAvailable === true;
  return {
    identities,
    allAvailable,
    hours: allAvailable ? null : (Number(input.hours) || (14 * 24)),
    points: Number(input.points) || (allAvailable ? MAX_COMPACT_SPARKLINE_POINTS : 336),
    granularityMinutes: allAvailable
      ? ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES
      : (Number(input.granularityMinutes) || 30),
    allowOneMinuteFallback: input.allowOneMinuteFallback === true,
    onMetrics: typeof input.onMetrics === 'function' ? input.onMetrics : null,
  };
}

function buildSolanaPayload(request, item, generatedAt) {
  const normalizedItem = item ? {
    ...item,
    chain: request.chain,
    valuationType: 'market-cap',
  } : null;
  return {
    generatedAt,
    chain: request.chain,
    valuationType: 'market-cap',
    resolution: 'solana-aggregate',
    minuteStartsAt: null,
    points: request.points,
    granularityMinutes: normalizedItem?.granularityMinutes
      ?? request.granularityMinutes ?? null,
    count: normalizedItem ? 1 : 0,
    item: normalizedItem,
  };
}

function buildRobinhoodItem(history) {
  const candles = history.candles.map((candle) => ({
    bucketTs: candle.bucketTs,
    granularityMinutes: candle.granularityMinutes,
    sourceGranularityMinutes: candle.sourceGranularityMinutes,
    valuationType: candle.valuationType,
    openFdvUsd: candle.openFdvUsd,
    highFdvUsd: candle.highFdvUsd,
    lowFdvUsd: candle.lowFdvUsd,
    closeFdvUsd: candle.closeFdvUsd,
    openPriceUsd: candle.openPriceUsd,
    highPriceUsd: candle.highPriceUsd,
    lowPriceUsd: candle.lowPriceUsd,
    closePriceUsd: candle.closePriceUsd,
    activity: candle.activity,
  }));
  return {
    chain: history.chain,
    address: history.address,
    valuationType: 'fdv',
    resolution: history.resolution,
    minuteStartsAt: history.minuteStartsAt,
    truncated: history.truncated,
    bucketCount: candles.length,
    firstBucketAt: history.firstBucketAt,
    latestBucketAt: history.latestBucketAt,
    oneMinuteAvailable: candles.some((candle) => (
      candle.sourceGranularityMinutes === 1
      && Date.parse(candle.bucketTs) >= Date.parse(history.minuteStartsAt)
    )),
    series: candles.map((candle) => candle.closeFdvUsd),
    candles,
  };
}

function buildSolanaItem(item) {
  return { ...item, chain: 'solana', valuationType: 'market-cap' };
}

function mergeReaderMetrics(byChain) {
  const entries = Object.entries(byChain);
  if (entries.length === 1) return { ...entries[0][1], chains: byChain };
  const values = entries.map(([, value]) => value);
  const sum = (field) => values.reduce((total, value) => total + (Number(value[field]) || 0), 0);
  return {
    source: entries.map(([chain, value]) => `${chain}:${value.source || 'unknown'}`).join(','),
    rows: sum('rows'), aggregateRows: sum('aggregateRows'), fallbackRows: sum('fallbackRows'),
    fallbackAddresses: sum('fallbackAddresses'),
    cacheHit: values.length > 0 && values.every((value) => value.cacheHit === true),
    queryDurationMs: Math.max(0, ...values.map((value) => Number(value.queryDurationMs) || 0)),
    buildDurationMs: Math.max(0, ...values.map((value) => Number(value.buildDurationMs) || 0)),
    totalDurationMs: Math.max(0, ...values.map((value) => Number(value.totalDurationMs) || 0)),
    chains: byChain,
  };
}

function createCatalogMarketHistoryService(options = {}) {
  const solanaReader = options.solanaReader || tokenMarketBucket1m;
  const robinhoodReader = options.robinhoodReader
    || createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: config.robinhoodMarketAggregateReader.enabled,
      fallbackEnabled: config.robinhoodMarketAggregateReader.fallbackEnabled,
      shadowCompareEnabled: config.robinhoodMarketAggregateReader.shadowCompareEnabled,
      verifiedCoverage: {
        from: config.robinhoodMarketAggregateReader.verifiedFrom,
        through: config.robinhoodMarketAggregateReader.verifiedThrough,
      },
    });
  const clock = options.now || (() => new Date());

  async function getSparklineBatch(input = {}) {
    const request = normalizeBatchRequest(input);
    const endAt = new Date(clock());
    const startAt = request.allAvailable
      ? null
      : new Date(endAt.getTime() - (request.hours * 60 * MINUTE_MS));
    const solanaAddresses = request.identities
      .filter((identity) => identity.chain === 'solana')
      .map((identity) => identity.address);
    const robinhoodAddresses = request.identities
      .filter((identity) => identity.chain === 'robinhood')
      .map((identity) => identity.address);
    const readerMetrics = {};
    const solanaOptions = {
      hours: request.hours,
      points: request.points,
      granularityMinutes: request.granularityMinutes,
      allowOneMinuteFallback: request.allowOneMinuteFallback,
    };
    if (request.allAvailable) solanaOptions.allAvailable = true;
    if (request.onMetrics) solanaOptions.onMetrics = (value) => { readerMetrics.solana = value; };

    const [solanaItems, robinhoodHistories] = await Promise.all([
      solanaAddresses.length
        ? solanaReader.listSparklineByAddresses(solanaAddresses, solanaOptions)
        : [],
      robinhoodAddresses.length
        ? robinhoodReader.getHistories({
          addresses: robinhoodAddresses,
          startAt,
          endAt,
          granularityMinutes: request.granularityMinutes,
          limit: request.points,
          ...(request.allAvailable ? { allAvailable: true } : {}),
          onMetrics: request.onMetrics
            ? (value) => { readerMetrics.robinhood = value; } : null,
        })
        : [],
    ]);
    if (request.onMetrics && Object.keys(readerMetrics).length > 0) {
      request.onMetrics(mergeReaderMetrics(readerMetrics));
    }
    const byKey = new Map();
    for (const item of solanaItems) {
      byKey.set(createTokenIdentity('solana', item.address).key, buildSolanaItem(item));
    }
    for (const history of robinhoodHistories) {
      byKey.set(createTokenIdentity('robinhood', history.address).key, buildRobinhoodItem(history));
    }
    const items = request.identities.map((identity) => byKey.get(identity.key)).filter(Boolean);
    return {
      generatedAt: endAt.toISOString(),
      chains: [...new Set(request.identities.map((identity) => identity.chain))],
      hours: request.hours,
      allAvailable: request.allAvailable,
      points: request.points,
      granularityMinutes: request.granularityMinutes,
      count: items.length,
      items,
    };
  }

  async function getExpandedSparkline(input = {}) {
    const request = normalizeRequest(input);
    const endAt = new Date(clock());
    const generatedAt = endAt.toISOString();
    if (request.chain === 'solana') {
      const item = await solanaReader.listExpandedSparklineByAddress(request.address, {
        points: request.points,
        granularityMinutes: request.granularityMinutes,
        allowOneMinuteFallback: request.allowOneMinuteFallback,
      });
      return buildSolanaPayload(request, item, generatedAt);
    }

    const granularityMinutes = request.granularityMinutes || 5;
    const startAt = new Date(
      endAt.getTime() - (request.points * granularityMinutes * MINUTE_MS),
    );
    const history = await robinhoodReader.getHistory({
      address: request.address,
      startAt,
      endAt,
      granularityMinutes,
      limit: request.points,
    });
    const item = buildRobinhoodItem(history);
    return {
      generatedAt,
      chain: request.chain,
      valuationType: 'fdv',
      resolution: history.resolution,
      minuteStartsAt: history.minuteStartsAt,
      points: request.points,
      granularityMinutes,
      count: item ? 1 : 0,
      item,
    };
  }

  return Object.freeze({ getExpandedSparkline, getSparklineBatch });
}

const service = createCatalogMarketHistoryService();

module.exports = {
  getExpandedSparkline: (...args) => service.getExpandedSparkline(...args),
  getSparklineBatch: (...args) => service.getSparklineBatch(...args),
  createCatalogMarketHistoryService,
  __private: {
    buildRobinhoodItem, buildSolanaItem, buildSolanaPayload,
    mergeReaderMetrics, normalizeBatchRequest, normalizeRequest,
  },
};
