const {
  createRobinhoodWalletRankingReadSnapshot,
} = require('../models/robinhood-wallet-ranking-read-snapshot');
const {
  createRobinhoodWalletRankingPriceReadRepository,
} = require('../models/robinhood-wallet-ranking-price-read');
const {
  createRobinhoodWalletRankingTokenDecimalsRepository,
} = require('../models/robinhood-wallet-ranking-token-decimals');
const {
  readRobinhoodWalletRankingGlobalCandidates,
} = require('./robinhood-wallet-ranking-global-candidates');
const {
  readRobinhoodWalletRankingWindowCoverage,
} = require('./robinhood-wallet-ranking-window-coverage');
const { rankOpenWalletPositions } = require('./robinhood-wallet-ranking-aggregate');

const WINDOW_MS = Object.freeze({
  '24h': 86400000, '7d': 604800000, '30d': 2592000000, ALL: null,
});

function normalizeInput(input) {
  if (!Object.hasOwn(WINDOW_MS, input.window)) throw new Error('window is invalid');
  const asOf = new Date(input.asOf);
  if (input.asOf == null || !Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  return { window: input.window, asOf, limit };
}

function batches(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function pairKey(item) {
  return `${item.tokenAddress}:${item.walletAddress}`;
}

function partialUniverse(global, input) {
  const ranking = rankOpenWalletPositions({ positions: [],
    window: input.window, asOf: input.asOf, limit: input.limit,
    positionSource: 'snapshot', universeComplete: false });
  return { ...ranking, candidateWalletCount: new Set(global.positions.map(
    (position) => position.walletAddress,
  )).size, reasons: [...new Set([...ranking.reasons, ...global.reasons])].sort(),
  pageCount: global.pageCount, nextAfter: global.nextAfter,
  positionFrontier: global.positionFrontier, readSnapshotConsistent: true,
  candidateUniverseComplete: false, rankingReady: false };
}

async function readEnrichment(database, global, input, options) {
  const pricesRepository = options.pricesRepository
    || createRobinhoodWalletRankingPriceReadRepository({ database });
  const decimalsRepository = options.decimalsRepository
    || createRobinhoodWalletRankingTokenDecimalsRepository({ database });
  const readCoverage = options.readCoverage || readRobinhoodWalletRankingWindowCoverage;
  const tokens = [...new Set(global.positions.map((position) => position.tokenAddress))];
  const prices = [];
  const decimals = [];
  for (const batch of batches(tokens, 100)) {
    prices.push(...await pricesRepository.getPrices({
      tokenAddresses: batch, window: input.window, asOf: input.asOf,
    }));
    decimals.push(...await decimalsRepository.getDecimals({
      tokenAddresses: batch, asOf: input.asOf,
    }));
  }
  const events = [];
  const windowStart = WINDOW_MS[input.window] == null ? null
    : new Date(input.asOf.getTime() - WINDOW_MS[input.window]);
  if (windowStart) {
    for (const batch of batches(global.positions, 20)) {
      events.push(...await readCoverage(database, {
        pairs: batch.map(({ tokenAddress, walletAddress }) => ({ tokenAddress, walletAddress })),
        windowStart, asOf: input.asOf, classificationVersion: options.classificationVersion,
      }));
    }
  }
  return { prices: new Map(prices.map((price) => [price.tokenAddress, price])),
    decimals: new Map(decimals.map((item) => [item.tokenAddress, item.tokenDecimals])),
    events: new Map(events.map((item) => [pairKey(item), item])) };
}

function compose(global, input, enrichment) {
  const positions = global.positions.map((position) => {
    const price = enrichment.prices.get(position.tokenAddress);
    const events = enrichment.events.get(pairKey(position));
    return { ...position,
      tokenDecimals: enrichment.decimals.get(position.tokenAddress) ?? null,
      currentPriceUsd: price?.currentPriceUsd ?? null,
      windowStartPriceUsd: price?.windowStartPriceUsd ?? null,
      events: events?.events || [], eventsComplete: events?.eventsComplete === true,
    };
  });
  const ranking = rankOpenWalletPositions({ positions, window: input.window,
    asOf: input.asOf, limit: input.limit, positionSource: 'snapshot',
    universeComplete: global.candidateUniverseComplete });
  const reasons = [...new Set([...ranking.reasons, ...global.reasons])].sort();
  return { ...ranking, coverage: reasons.length ? 'partial' : 'complete',
    rankingIsComplete: reasons.length === 0, rankingReady: reasons.length === 0,
    reasons, pageCount: global.pageCount, nextAfter: global.nextAfter,
    positionFrontier: global.positionFrontier, readSnapshotConsistent: true,
    candidateUniverseComplete: global.candidateUniverseComplete };
}

function createRobinhoodWalletRankingGlobal(options = {}) {
  const snapshotRunner = options.snapshotRunner
    || createRobinhoodWalletRankingReadSnapshot({ database: options.database });
  return {
    async getRanking(input = {}) {
      const normalized = normalizeInput(input);
      return snapshotRunner.run(async (database) => {
        const global = await readRobinhoodWalletRankingGlobalCandidates(database,
          { ...input, asOf: normalized.asOf }, options);
        if (!global.candidateUniverseComplete) return partialUniverse(global, normalized);
        const enrichment = await readEnrichment(database, global,
          normalized, { ...options, classificationVersion: input.classificationVersion });
        return compose(global, normalized, enrichment);
      });
    },
  };
}

module.exports = { createRobinhoodWalletRankingGlobal };
