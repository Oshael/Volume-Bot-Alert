const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function createRobinhoodHolderDevHoldSource(options = {}) {
  const database = options.database || db;

  async function loadDevHoldEvidence(inputTokenAddress) {
    const tokenAddress = normalizeTokenAddress('robinhood', inputTokenAddress);
    const { rows } = await database.query(
      `SELECT state.token_address, state.ledger_status,
              state.live_through_block::text, state.live_through_hash,
              attribution.creator_address, attribution.source,
              attribution.attribution_block::text, attribution.attribution_tx_hash,
              attribution.attribution_factory_address, attribution.last_resolved_at,
              COALESCE(creator.balance_raw, 0)::text AS creator_balance_raw,
              supply.total_supply_raw::text
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_token_attributions attribution
           ON attribution.chain = state.chain AND attribution.token_address = state.token_address
         LEFT JOIN LATERAL (
           SELECT balance_raw FROM robinhood_holder_balances
            WHERE chain = state.chain AND token_address = state.token_address
              AND wallet_address = attribution.creator_address
         ) creator ON true
         LEFT JOIN LATERAL (
           SELECT SUM(balance_raw) AS total_supply_raw FROM robinhood_holder_balances
            WHERE chain = state.chain AND token_address = state.token_address
         ) supply ON true
        WHERE state.chain = 'robinhood' AND state.token_address = $1`,
      [tokenAddress]
    );
    const row = rows[0];
    if (!row) return Object.freeze({ status: 'deferred', reason: 'holder_state_missing' });
    if (row.ledger_status !== 'live' || row.live_through_block == null
        || row.live_through_hash == null) {
      return Object.freeze({ status: 'deferred', reason: 'holder_frontier_unavailable' });
    }
    if (row.creator_address == null || row.creator_address === ZERO_ADDRESS) {
      return Object.freeze({
        status: 'unavailable', tokenAddress, reason: 'creator_unavailable',
        evidence: Object.freeze({ source: 'robinhood_token_attributions' }),
      });
    }
    if (row.attribution_block != null
        && BigInt(row.attribution_block) > BigInt(row.live_through_block)) {
      return Object.freeze({ status: 'deferred', reason: 'creator_frontier_ahead' });
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
        blockNumber: row.live_through_block, blockHash: row.live_through_hash,
      }),
      creatorAddress: row.creator_address,
      creatorBalanceRaw: row.creator_balance_raw,
      totalSupplyRaw: row.total_supply_raw,
      attribution: Object.freeze({
        source: row.source,
        blockNumber: row.attribution_block,
        transactionHash: row.attribution_tx_hash,
        factoryAddress: row.attribution_factory_address,
        resolvedAt: new Date(row.last_resolved_at).toISOString(),
      }),
    });
  }

  return Object.freeze({ loadDevHoldEvidence });
}

module.exports = { createRobinhoodHolderDevHoldSource };
