const { BLOCKED_RECOVERY_ERROR } = require('./robinhood-head-processing');

function createV4BlockedPreviewRepository(database) {
  return {
    async targets(throughBlock) {
      const { rows } = await database.query(
        `WITH blocked AS MATERIALIZED (
           SELECT DISTINCT ON (state.market_key) state.market_key, state.block_number,
                  payload.block_hash, state.transaction_hash, state.log_index
           FROM robinhood_head_capture_states state
           JOIN robinhood_head_captures payload USING (chain, transaction_hash, log_index)
           WHERE state.chain = 'robinhood' AND state.stream = 'market'
             AND state.protocol = 'uniswap-v4' AND state.processing_status = 'blocked'
             AND state.last_error = $1 AND state.block_number <= $2
           ORDER BY state.market_key, state.block_number, state.log_index
         ) SELECT b.market_key, b.block_number::text AS blocked_block,
                  b.block_hash, b.transaction_hash, b.log_index::text AS log_index,
                  r.pool_id, r.discovery_block::text, r.tick_spacing, r.origin_address
           FROM blocked b LEFT JOIN robinhood_pool_registry r
             ON r.chain = 'robinhood' AND r.protocol = 'uniswap-v4' AND r.market_key = b.market_key
           ORDER BY b.block_number, b.log_index LIMIT 8`, [BLOCKED_RECOVERY_ERROR, throughBlock]
      );
      return rows;
    },
    async identities(events) {
      if (!events.length) return new Map();
      if (events.length > 500) throw new Error('Identity lookup exceeds 500 events');
      const { rows } = await database.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS i("transactionHash" text, "logIndex" text)
         ) SELECT i."transactionHash", i."logIndex", to_jsonb(d) || jsonb_build_object(
                    'liquidity_delta', d.liquidity_delta::text, 'block_number', d.block_number::text) AS ledger,
                  state.processing_status AS capture_status,
                  EXISTS (SELECT 1 FROM robinhood_processed_logs p
                    WHERE p.chain = 'robinhood' AND p.transaction_hash = i."transactionHash"
                      AND p.log_index = i."logIndex"::bigint) AS processed
           FROM input i LEFT JOIN robinhood_v4_liquidity_deltas d
             ON d.chain = 'robinhood' AND d.transaction_hash = i."transactionHash"
               AND d.log_index = i."logIndex"::bigint
           LEFT JOIN robinhood_head_capture_states state
             ON state.chain = 'robinhood' AND state.transaction_hash = i."transactionHash"
               AND state.log_index = i."logIndex"::bigint`, [JSON.stringify(events)]
      );
      return new Map(rows.map((row) => [`${row.transactionHash}:${row.logIndex}`, row]));
    },
    async ranges(poolId) {
      const { rows } = await database.query(
        `SELECT tick_lower, tick_upper, liquidity_gross::text
         FROM robinhood_v4_liquidity_ranges WHERE chain = 'robinhood' AND pool_id = $1
         ORDER BY tick_lower, tick_upper`, [poolId]
      );
      return rows;
    },
  };
}

module.exports = { createV4BlockedPreviewRepository };
