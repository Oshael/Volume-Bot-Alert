const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

function normalizeRow(row, tokenAddress) {
  if (!row) return Object.freeze({ status: 'deferred', reason: 'holder_state_missing' });
  if (row.ledger_status !== 'live' || row.live_through_block == null
      || row.live_through_hash == null) {
    return Object.freeze({ status: 'deferred', reason: 'holder_frontier_unavailable' });
  }
  if (row.total_supply_raw == null || BigInt(row.total_supply_raw) <= 0n) {
    return Object.freeze({
      status: 'unavailable', tokenAddress, reason: 'supply_unavailable',
      evidence: Object.freeze({ source: 'robinhood_holder_balances' }),
    });
  }
  return Object.freeze({
    status: 'ready', tokenAddress,
    frontier: Object.freeze({
      blockNumber: String(row.live_through_block), blockHash: row.live_through_hash,
    }),
    totalSupplyRaw: String(row.total_supply_raw),
    top10: Object.freeze({
      balanceRaw: String(row.top_10_balance_raw), walletCount: String(row.top_10_wallet_count),
    }),
    top50: Object.freeze({
      balanceRaw: String(row.top_50_balance_raw), walletCount: String(row.top_50_wallet_count),
    }),
  });
}

function createRobinhoodHolderTopDistributionSource(options = {}) {
  const database = options.database || db;

  async function loadTopDistribution(inputTokenAddress) {
    const tokenAddress = normalizeTokenAddress('robinhood', inputTokenAddress);
    const { rows } = await database.query(
      `SELECT state.ledger_status, state.live_through_block::text,
              state.live_through_hash, distribution.total_supply_raw,
              distribution.top_10_balance_raw, distribution.top_10_wallet_count,
              distribution.top_50_balance_raw, distribution.top_50_wallet_count
         FROM robinhood_holder_token_states state
         LEFT JOIN LATERAL (
           SELECT SUM(ranked.balance_raw)::text AS total_supply_raw,
                  COALESCE(SUM(ranked.balance_raw)
                    FILTER (WHERE ranked.holder_rank <= 10), 0)::text AS top_10_balance_raw,
                  COUNT(*) FILTER (WHERE ranked.holder_rank <= 10)::text
                    AS top_10_wallet_count,
                  COALESCE(SUM(ranked.balance_raw)
                    FILTER (WHERE ranked.holder_rank <= 50), 0)::text AS top_50_balance_raw,
                  COUNT(*) FILTER (WHERE ranked.holder_rank <= 50)::text
                    AS top_50_wallet_count
             FROM (
               SELECT balance.balance_raw,
                      ROW_NUMBER() OVER (
                        ORDER BY balance.balance_raw DESC, balance.wallet_address ASC
                      ) AS holder_rank
                 FROM robinhood_holder_balances balance
                WHERE balance.chain = state.chain
                  AND balance.token_address = state.token_address
             ) ranked
         ) distribution ON TRUE
        WHERE state.chain = 'robinhood' AND state.token_address = $1`,
      [tokenAddress]
    );
    return normalizeRow(rows[0], tokenAddress);
  }

  return Object.freeze({ loadTopDistribution });
}

module.exports = {
  createRobinhoodHolderTopDistributionSource,
  __private: { normalizeRow },
};
