const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const SQL = `SELECT requested.token_address, swap.token_decimals
  FROM unnest($1::varchar[]) AS requested(token_address)
  LEFT JOIN LATERAL (
    SELECT token_decimals FROM robinhood_wallet_swaps
    WHERE chain='robinhood' AND token_address=requested.token_address
      AND token_decimals IS NOT NULL AND block_time <= $2::timestamptz
    ORDER BY block_time DESC, block_number DESC, action_index DESC LIMIT 1
  ) swap ON TRUE ORDER BY requested.token_address`;

function createRobinhoodWalletRankingTokenDecimalsRepository(options = {}) {
  const database = options.database || db;
  return {
    async getDecimals({ tokenAddresses, asOf } = {}) {
      if (!Array.isArray(tokenAddresses) || tokenAddresses.length > 100) {
        throw new Error('tokenAddresses must contain at most 100 tokens');
      }
      const tokens = [...new Set(tokenAddresses.map((token) => (
        normalizeTokenAddress('robinhood', token)
      )))].sort();
      const date = new Date(asOf);
      if (asOf == null || !Number.isFinite(date.getTime())) throw new Error('asOf is invalid');
      if (!tokens.length) return [];
      const result = await database.queryWithStatementTimeout(SQL, [tokens, date], 5000);
      return result.rows.map((row) => ({ tokenAddress: row.token_address,
        tokenDecimals: row.token_decimals == null ? null : Number(row.token_decimals) }));
    },
  };
}

module.exports = { createRobinhoodWalletRankingTokenDecimalsRepository };
