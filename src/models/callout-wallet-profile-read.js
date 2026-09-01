'use strict';

const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const MAX_WALLETS = 100;

const PROFILE_BY_EVM_WALLET_SQL = `SELECT DISTINCT ON (wallet.address_normalized)
  wallet.address_normalized, profile.platform, profile.platform_user_id,
  profile.username, profile.x_username, profile.display_name,
  profile.profile_picture_url
FROM callout_wallet_observations wallet
INNER JOIN callout_profiles profile
  ON profile.platform = wallet.platform
 AND profile.platform_user_id = wallet.platform_user_id
WHERE wallet.address_normalized = ANY($1::text[])
  AND wallet.chain_family = 'evm'
  AND wallet.platform IN ('fomo', 'pump')
ORDER BY wallet.address_normalized,
  (profile.profile_picture_url IS NOT NULL) DESC,
  (COALESCE(profile.display_name, profile.username, profile.x_username) IS NOT NULL) DESC,
  CASE WHEN wallet.source_type = 'platform_reported' THEN 0 ELSE 1 END,
  wallet.last_observed_at DESC, profile.last_observed_at DESC,
  profile.platform, profile.platform_user_id`;

function normalizeWallets(values) {
  if (!Array.isArray(values) || values.length > MAX_WALLETS) {
    throw new TypeError(`walletAddresses must contain at most ${MAX_WALLETS} addresses`);
  }
  return [...new Set(values.map((value) => normalizeTokenAddress('robinhood', value)))];
}

function publicProfile(row) {
  return Object.freeze({
    address: row.address_normalized,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    username: row.username || null,
    xUsername: row.x_username || null,
    displayName: row.display_name || null,
    profilePictureUrl: row.profile_picture_url || null,
  });
}

function createCalloutWalletProfileReadRepository(options = {}) {
  const database = options.database || db;

  async function findByWalletAddresses(walletAddresses) {
    const addresses = normalizeWallets(walletAddresses);
    if (addresses.length === 0) return [];
    const result = await database.query(PROFILE_BY_EVM_WALLET_SQL, [addresses]);
    return Object.freeze(result.rows.map(publicProfile));
  }

  return Object.freeze({ findByWalletAddresses });
}

module.exports = {
  createCalloutWalletProfileReadRepository,
  __private: { MAX_WALLETS, PROFILE_BY_EVM_WALLET_SQL, normalizeWallets, publicProfile },
};
