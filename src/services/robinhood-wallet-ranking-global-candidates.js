const {
  createRobinhoodWalletRankingReadSnapshot,
} = require('../models/robinhood-wallet-ranking-read-snapshot');
const {
  createRobinhoodWalletRankingPositionReadRepository,
} = require('../models/robinhood-wallet-ranking-position-read');

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

function createRobinhoodWalletRankingGlobalCandidates(options = {}) {
  const snapshotRunner = options.snapshotRunner
    || createRobinhoodWalletRankingReadSnapshot({ database: options.database });
  return {
    async read(input = {}) {
      return snapshotRunner.run(async (database) => {
        const repository = options.positionsRepository
          || createRobinhoodWalletRankingPositionReadRepository({ database });
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
        return {
          projectionVersion: input.projectionVersion,
          positions,
          pageCount,
          nextAfter: after,
          readSnapshotConsistent: true,
          candidateUniverseComplete: !hasMore,
          reasons: hasMore ? ['candidate_universe_limit_reached'] : [],
        };
      });
    },
  };
}

module.exports = { createRobinhoodWalletRankingGlobalCandidates };
