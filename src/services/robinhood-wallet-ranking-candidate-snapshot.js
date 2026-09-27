const {
  createRobinhoodWalletRankingReadSnapshot,
} = require('../models/robinhood-wallet-ranking-read-snapshot');
const {
  createRobinhoodWalletRankingPositionReadRepository,
} = require('../models/robinhood-wallet-ranking-position-read');
const {
  createRobinhoodWalletRankingPriceReadRepository,
} = require('../models/robinhood-wallet-ranking-price-read');
const {
  readRobinhoodWalletRankingWindowCoverage,
} = require('./robinhood-wallet-ranking-window-coverage');

const MAX_POSITIONS = 20;
const WINDOW_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  ALL: null,
});

function pairKey(item) {
  return `${item.tokenAddress}:${item.walletAddress}`;
}

function normalizedInput(input) {
  if (!Object.hasOwn(WINDOW_MS, input.window)) throw new Error('window is invalid');
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
  return { window: input.window, asOf };
}

function mergeCandidates(positions, prices, events) {
  const priceByToken = new Map(prices.map((price) => [price.tokenAddress, price]));
  const eventsByPair = new Map(events.map((item) => [pairKey(item), item]));
  return positions.map((position) => ({
    ...position,
    price: priceByToken.get(position.tokenAddress) || null,
    windowEvents: eventsByPair.get(pairKey(position)) || null,
    projectionAligned: false,
  }));
}

function createRobinhoodWalletRankingCandidateSnapshot(options = {}) {
  const snapshotRunner = options.snapshotRunner
    || createRobinhoodWalletRankingReadSnapshot({ database: options.database });
  return {
    async getCandidates(input = {}) {
      const { window, asOf } = normalizedInput(input);
      return snapshotRunner.run(async (database) => {
        const repositoryOptions = { database };
        const positionsRepository = options.positionsRepository
          || createRobinhoodWalletRankingPositionReadRepository(repositoryOptions);
        const pricesRepository = options.pricesRepository
          || createRobinhoodWalletRankingPriceReadRepository(repositoryOptions);
        const readCoverage = options.readCoverage
          || readRobinhoodWalletRankingWindowCoverage;
        const page = await positionsRepository.getOpenPositions({
          tokenAddresses: input.tokenAddresses, projectionVersion: input.projectionVersion,
          limit: MAX_POSITIONS,
        });
        const positions = page.positions;
        const tokens = [...new Set(positions.map((item) => item.tokenAddress))];
        const prices = await pricesRepository.getPrices({
          tokenAddresses: tokens, window, asOf,
        });
        const windowStart = WINDOW_MS[window] == null
          ? null : new Date(asOf.getTime() - WINDOW_MS[window]);
        const events = windowStart && positions.length
          ? await readCoverage(database, {
            pairs: positions.map(({ tokenAddress, walletAddress }) => ({
              tokenAddress, walletAddress,
            })),
            windowStart, asOf, classificationVersion: input.classificationVersion,
          }) : [];
        return {
          window, asOf: asOf.toISOString(),
          windowStart: windowStart?.toISOString() ?? null,
          projectionVersion: page.projectionVersion,
          candidates: mergeCandidates(positions, prices, events),
          hasMorePositions: page.hasMore,
          readSnapshotConsistent: true,
          candidateUniverseComplete: false,
          rankingReady: false,
          reasons: ['candidate_universe_incomplete', 'projection_alignment_unverified'],
        };
      });
    },
  };
}

module.exports = { createRobinhoodWalletRankingCandidateSnapshot };
