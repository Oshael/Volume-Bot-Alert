const tokenCatalog = require('../models/token-catalog');
const dexscreener = require('./dexscreener');
const catalogWorker = require('./catalog-worker');
const robinhoodCatalog = require('../models/robinhood-catalog');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');
const { WATCHLIST_SOURCE } = require('../utils/watchlist-token-source');

function isSoftArchivedToken(token) {
  return String(token?.suppressed_reason || '').trim().toLowerCase() === 'cleanup_soft_archive';
}

async function upsertWatchlistCatalogToken(address, options = {}) {
  const chain = normalizeTokenChain(options.chain || 'solana');
  const addr = normalizeTokenAddress(chain, address);
  if (chain === 'robinhood') {
    const token = await robinhoodCatalog.ensureWatchlistToken(addr);
    return { token, bootstrapState: 'scheduled' };
  }
  if (chain !== 'solana') {
    throw new Error(`Watchlist token bootstrap does not support ${chain}`);
  }
  const eagerEvaluate = options.eagerEvaluate === true;

  const existing = await tokenCatalog.getByAddress(addr);
  let catalogToken = null;

  if (isSoftArchivedToken(existing)) {
    catalogToken = await tokenCatalog.reactivateSoftArchivedToken(addr, {
      source: WATCHLIST_SOURCE,
    });
    if (!catalogToken) {
      throw new Error('Failed to reactivate archived Watchlist token');
    }
  } else {
    const upserted = await tokenCatalog.upsertToken({
      address: addr,
      chain: 'solana',
      source: WATCHLIST_SOURCE,
    });
    catalogToken = await tokenCatalog.scheduleImmediateEvaluation(addr) || upserted;
  }

  let bootstrapState = 'scheduled';
  if (eagerEvaluate) {
    try {
      dexscreener.clearCache(addr);
      const dexData = await dexscreener.getTokenPairs(addr, { priority: 'manual' });
      await catalogWorker.__private.evaluateTokenWithData(catalogToken, dexData);
      bootstrapState = 'evaluated';
    } catch (error) {
      console.error(`[WatchlistTokenBootstrap] Immediate evaluation failed for ${addr}:`, error.message);
    }
  }

  return {
    token: catalogToken,
    bootstrapState,
  };
}

module.exports = {
  upsertWatchlistCatalogToken,
  __private: {
    isSoftArchivedToken,
  },
};
