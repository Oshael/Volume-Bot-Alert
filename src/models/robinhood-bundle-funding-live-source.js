const db = require('./db');

const CHAIN = 'robinhood';
const CANDIDATES_SQL = `SELECT buy.token_address, buy.wallet_address,
       anchor.launch_block::text, buy.block_number::text AS first_buy_block,
       buy.transaction_index::text AS first_buy_transaction_index
  FROM robinhood_token_launch_anchors anchor
  INNER JOIN robinhood_wallet_token_first_buys buy
    ON buy.chain = anchor.chain AND buy.token_address = anchor.token_address
  INNER JOIN robinhood_holder_token_states state
    ON state.chain = anchor.chain AND state.token_address = anchor.token_address
 WHERE anchor.chain = $1 AND anchor.token_address = $2
   AND anchor.launch_block = $3::bigint AND state.ledger_status = 'live'
   AND state.live_through_block >= $4::bigint
   AND buy.block_number BETWEEN anchor.launch_block AND anchor.launch_block + 3
   AND buy.block_number <= $4::bigint
   AND buy.wallet_address NOT IN (
     '0x0000000000000000000000000000000000000000',
     '0x000000000000000000000000000000000000dead'
   )
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_infrastructure_registry infrastructure
      WHERE infrastructure.chain = buy.chain AND infrastructure.address = buy.wallet_address
        AND infrastructure.valid_from_block <= buy.block_number
        AND (infrastructure.valid_through_block IS NULL
          OR infrastructure.valid_through_block >= buy.block_number)
   )
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_pool_registry pool
      WHERE pool.chain = buy.chain AND pool.token_address = buy.token_address
        AND pool.discovery_block <= buy.block_number
        AND CASE WHEN pool.protocol = 'uniswap-v4'
          THEN pool.origin_address ELSE pool.pool_address END = buy.wallet_address
   )
 ORDER BY buy.block_number, buy.transaction_index, buy.wallet_address LIMIT 10001`;

function createRobinhoodBundleFundingLiveSource(options = {}) {
  const database = options.database || db;
  async function loadCandidates(task) {
    const { rows } = await database.query(CANDIDATES_SQL, [
      CHAIN, task.tokenAddress, task.anchorBlock, task.sourceThroughBlock,
    ]);
    if (rows.length > 10_000) throw new Error('live funding candidate cap exceeded');
    return Object.freeze(rows.map((row) => Object.freeze({
      tokenAddress: row.token_address, walletAddress: row.wallet_address,
      launchBlock: row.launch_block, firstBuyBlock: row.first_buy_block,
      firstBuyTransactionIndex: row.first_buy_transaction_index,
    })));
  }
  return Object.freeze({ loadCandidates });
}

module.exports = {
  createRobinhoodBundleFundingLiveSource, __private: { CANDIDATES_SQL },
};
