const robinhoodCatalog = require('../models/robinhood-catalog');
const { normalizeTokenAddress } = require('../utils/token-identity');

const DAY_MS = 24 * 60 * 60 * 1000;

function createRobinhoodCatalogMetadataStore(options = {}) {
  const catalog = options.catalog || robinhoodCatalog;
  const now = options.now || Date.now;
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || DAY_MS);

  async function get(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const [row] = await catalog.listMetadata([address]);
    if (!row) return null;
    const checkedAtMs = new Date(row.robinhood_dexscreener_checked_at).getTime();
    if (!Number.isFinite(checkedAtMs) || checkedAtMs + ttlMs <= now()) return null;
    return {
      chain: 'robinhood', address,
      imageUrl: row.last_image_url || null,
      websiteUrl: row.last_website_url || null,
      twitterUrl: row.last_twitter_url || null,
      telegramUrl: row.last_community_url || null,
      fetchedAtMs: checkedAtMs,
    };
  }

  async function set(tokenAddress, metadata) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    return catalog.recordDexscreenerMetadata({ address, ...metadata });
  }

  async function markChecked(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    return catalog.recordDexscreenerMetadata({ address });
  }

  return Object.freeze({ get, markChecked, set });
}

module.exports = { DAY_MS, createRobinhoodCatalogMetadataStore };
