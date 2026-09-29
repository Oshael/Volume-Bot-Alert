const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const SQL = `SELECT DISTINCT ON (wallet.address_normalized)
    wallet.address_normalized, profile.platform, profile.platform_user_id,
    profile.username, profile.x_username, profile.display_name,
    profile.profile_picture_url
  FROM callout_wallet_observations wallet
  JOIN callout_profiles profile ON profile.platform=wallet.platform
    AND profile.platform_user_id=wallet.platform_user_id
  WHERE wallet.chain_key='robinhood'
    AND wallet.address_normalized=ANY($1::text[])
  ORDER BY wallet.address_normalized,
    (profile.profile_picture_url IS NOT NULL) DESC,
    wallet.last_observed_at DESC, profile.platform, profile.platform_user_id`;

function createRobinhoodWalletRankingProfileRepository(options = {}) {
  const database = options.database || db;
  return {
    async findByWalletAddresses(values) {
      if (!Array.isArray(values) || values.length > 50) {
        throw new Error('walletAddresses must contain at most 50 addresses');
      }
      const addresses = [...new Set(values.map((value) => (
        normalizeTokenAddress('robinhood', value)
      )))];
      if (!addresses.length) return [];
      const result = await database.queryWithStatementTimeout(SQL, [addresses], 5000);
      return result.rows.map((row) => ({
        address: row.address_normalized, platform: row.platform,
        platformUserId: row.platform_user_id, username: row.username || null,
        xUsername: row.x_username || null, displayName: row.display_name || null,
        profilePictureUrl: row.profile_picture_url || null,
      }));
    },
  };
}

module.exports = { createRobinhoodWalletRankingProfileRepository };
