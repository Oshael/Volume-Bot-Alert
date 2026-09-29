const {
  createRobinhoodWalletRankingReadSnapshot,
} = require('../models/robinhood-wallet-ranking-read-snapshot');
const {
  createRobinhoodWalletRankingPositionReadRepository,
} = require('../models/robinhood-wallet-ranking-position-read');
const {
  createRobinhoodWalletRankingPositionFrontierRepository,
  isRobinhoodWalletRankingPositionAligned,
} = require('../models/robinhood-wallet-ranking-position-frontier');

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function validatePage(page, after) {
  if (!page || !Array.isArray(page.positions) || page.positions.length > PAGE_SIZE
    || typeof page.hasMore !== 'boolean') {
    throw new Error('global candidate page is invalid');
  }
  if (page.hasMore && (!page.positions.length || !page.nextAfter)) {
    throw new Error('global candidate cursor is missing');
  }
  if (page.hasMore && after
    && (page.nextAfter.tokenAddress < after.tokenAddress
      || (page.nextAfter.tokenAddress === after.tokenAddress
        && page.nextAfter.walletAddress <= after.walletAddress))) {
    throw new Error('global candidate cursor did not advance');
  }
}

function validatedAsOf(input) {
  const asOf = new Date(input.asOf);
  if (input.asOf == null || !Number.isFinite(asOf.getTime())) {
    throw new Error('asOf is invalid');
  }
  return asOf;
}

async function readRobinhoodWalletRankingGlobalCandidates(database, input = {}, options = {}) {
  const asOf = validatedAsOf(input);
  const repository = options.positionsRepository
    || createRobinhoodWalletRankingPositionReadRepository({ database });
  const frontierRepository = options.frontierRepository
    || createRobinhoodWalletRankingPositionFrontierRepository({ database });
  const positions = [];
  let after = null;
  let pageCount = 0;
  let hasMore = true;
  while (hasMore && pageCount < MAX_PAGES) {
    const page = await repository.getGlobalOpenPositions({
      projectionVersion: input.projectionVersion, limit: PAGE_SIZE, after,
    });
    validatePage(page, after);
    positions.push(...page.positions);
    pageCount += 1;
    hasMore = page.hasMore;
    after = hasMore ? page.nextAfter : null;
  }
  const positionFrontier = await frontierRepository.inspectAsOf({
    projectionVersion: input.projectionVersion, asOf,
  });
  const alignedPositions = positions.map((position) => ({
    ...position,
    projectionAligned: isRobinhoodWalletRankingPositionAligned(
      position, positionFrontier,
    ),
  }));
  const outsideFrontier = positionFrontier.frontierChecksPassed
    && alignedPositions.some((position) => !position.projectionAligned);
  return {
    projectionVersion: input.projectionVersion,
    asOf: asOf.toISOString(),
    positions: alignedPositions,
    positionFrontier,
    pageCount,
    nextAfter: after,
    readSnapshotConsistent: true,
    candidateUniverseComplete: !hasMore,
    reasons: [...(hasMore ? ['candidate_universe_limit_reached'] : []),
      ...positionFrontier.reasons,
      ...(outsideFrontier ? ['position_outside_frontier'] : [])],
  };
}

function createRobinhoodWalletRankingGlobalCandidates(options = {}) {
  const snapshotRunner = options.snapshotRunner
    || createRobinhoodWalletRankingReadSnapshot({ database: options.database });
  return {
    async read(input = {}) {
      validatedAsOf(input);
      return snapshotRunner.run((database) => (
        readRobinhoodWalletRankingGlobalCandidates(database, input, options)
      ));
    },
  };
}

module.exports = { createRobinhoodWalletRankingGlobalCandidates,
  readRobinhoodWalletRankingGlobalCandidates };
