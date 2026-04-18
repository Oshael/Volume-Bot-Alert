const tokenCatalog = require('../models/token-catalog');
const dexscreener = require('./dexscreener');
const catalogWorker = require('./catalog-worker');

function isSoftArchivedToken(token) {
  return String(token?.suppressed_reason || '').trim().toLowerCase() === 'cleanup_soft_archive';
}

async function upsertManualCatalogToken(address, options = {}) {
  const addr = String(address || '').trim();
  const eagerEvaluate = options.eagerEvaluate === true;

  const existing = await tokenCatalog.getByAddress(addr);
  let catalogToken = null;

  if (isSoftArchivedToken(existing)) {
    catalogToken = await tokenCatalog.reactivateSoftArchivedToken(addr, {
      source: 'user-manual',
    });
    if (!catalogToken) {
      throw new Error('Failed to reactivate archived manual token');
    }
  } else {
    const upserted = await tokenCatalog.upsertToken({
      address: addr,
      chain: 'solana',
      source: 'user-manual',
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
      console.error(`[ManualTokenBootstrap] Immediate evaluation failed for ${addr}:`, error.message);
    }
  }

  return {
    token: catalogToken,
    bootstrapState,
  };
}

module.exports = {
  upsertManualCatalogToken,
  __private: {
    isSoftArchivedToken,
  },
};
