const db = require('./db');

const CHAIN = 'robinhood';
const BARRIERS_SQL = `WITH actors AS MATERIALIZED (
  SELECT DISTINCT actor.address, actor.observed_block::bigint AS observed_block
    FROM jsonb_to_recordset($2::jsonb) AS actor(address text, observed_block text)
) SELECT DISTINCT actor.address
  FROM actors actor
  WHERE EXISTS (
    SELECT 1 FROM robinhood_infrastructure_registry infrastructure
     WHERE infrastructure.chain = $1 AND infrastructure.address = actor.address
       AND infrastructure.valid_from_block <= actor.observed_block
       AND (infrastructure.valid_through_block IS NULL
         OR infrastructure.valid_through_block >= actor.observed_block)
  ) OR EXISTS (
    SELECT 1 FROM robinhood_pool_registry pool
     WHERE pool.chain = $1 AND pool.protocol IN ('uniswap-v2', 'uniswap-v3')
       AND pool.discovery_block <= actor.observed_block AND pool.pool_address = actor.address
  ) ORDER BY actor.address`;
const V4_ORIGINS_SQL = `SELECT origin_address AS address,
       MIN(discovery_block)::text AS discovery_block
  FROM robinhood_pool_registry
 WHERE chain = $1 AND protocol = 'uniswap-v4' AND origin_address IS NOT NULL
 GROUP BY origin_address`;
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
  let v4OriginsPromise;
  async function loadV4Origins() {
    v4OriginsPromise ||= database.query(V4_ORIGINS_SQL, [CHAIN]).then(({ rows }) => rows);
    return v4OriginsPromise.catch((error) => { v4OriginsPromise = null; throw error; });
  }
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
  async function loadBarrierAddresses(candidates, evidence) {
    const actors = new Map();
    const add = (address, observedBlock) => actors.set(`${address}:${observedBlock}`, {
      address, observed_block: String(observedBlock),
    });
    for (const item of candidates) add(item.walletAddress, item.firstBuyBlock);
    for (const item of evidence) {
      add(item.fromAddress, item.blockNumber); add(item.toAddress, item.blockNumber);
    }
    const actorRows = [...actors.values()];
    const [barriers, v4Origins] = await Promise.all([
      database.query(BARRIERS_SQL, [CHAIN, JSON.stringify(actorRows)]),
      loadV4Origins(),
    ]);
    const addresses = new Set(barriers.rows.map(({ address }) => address));
    for (const origin of v4Origins) {
      if (actorRows.some((actor) => actor.address === origin.address
          && BigInt(actor.observed_block) >= BigInt(origin.discovery_block))) {
        addresses.add(origin.address);
      }
    }
    return Object.freeze([...addresses].sort());
  }
  return Object.freeze({ loadCandidates, loadBarrierAddresses });
}

module.exports = {
  createRobinhoodBundleFundingLiveSource,
  __private: { BARRIERS_SQL, CANDIDATES_SQL, V4_ORIGINS_SQL },
};
