const db = require('./db');

const LOCK_KEY = 'robinhood-v4-liquidity-materialization';

function createRobinhoodV4LiquidityMaterialization(options = {}) {
  const database = options.database || db;

  async function materialize() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
      const replay = await client.query(
        `SELECT * FROM robinhood_v4_liquidity_replay_state
         WHERE chain = 'robinhood' FOR UPDATE`
      );
      const source = replay.rows[0];
      if (!source || source.status !== 'completed' || source.checkpoint_hash == null) {
        throw new Error('V4 liquidity replay must be completed before materialization');
      }
      const invalid = await client.query(
        `SELECT pool_id, tick_lower, tick_upper, SUM(liquidity_delta) AS liquidity_gross
         FROM robinhood_v4_liquidity_deltas
         WHERE chain = 'robinhood'
         GROUP BY pool_id, tick_lower, tick_upper
         HAVING SUM(liquidity_delta) < 0 OR COUNT(DISTINCT market_key) <> 1
         LIMIT 1`
      );
      if (invalid.rowCount) {
        const row = invalid.rows[0];
        throw new Error(`Invalid V4 liquidity at ${row.pool_id}:${row.tick_lower}:${row.tick_upper}`);
      }
      await client.query(`DELETE FROM robinhood_v4_liquidity_ranges WHERE chain = 'robinhood'`);
      const ranges = await client.query(
        `INSERT INTO robinhood_v4_liquidity_ranges (
           chain, pool_id, market_key, tick_lower, tick_upper, liquidity_gross
         )
         SELECT 'robinhood', pool_id, MIN(market_key), tick_lower, tick_upper,
                SUM(liquidity_delta)
         FROM robinhood_v4_liquidity_deltas
         WHERE chain = 'robinhood'
         GROUP BY pool_id, tick_lower, tick_upper
         HAVING SUM(liquidity_delta) > 0
         RETURNING 1`
      );
      await client.query(
        `INSERT INTO robinhood_v4_liquidity_materialization_state (
           chain, replay_start_block, replay_target_block, replay_checkpoint_hash
         ) VALUES ('robinhood', $1, $2, $3)
         ON CONFLICT (chain) DO UPDATE SET
           replay_start_block = EXCLUDED.replay_start_block,
           replay_target_block = EXCLUDED.replay_target_block,
           replay_checkpoint_hash = EXCLUDED.replay_checkpoint_hash,
           materialized_at = NOW(),
           version = robinhood_v4_liquidity_materialization_state.version + 1`,
        [source.start_block, source.target_block, source.checkpoint_hash]
      );
      await client.query('COMMIT');
      return { ranges: ranges.rowCount, replayTargetBlock: String(source.target_block) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ materialize });
}

module.exports = { LOCK_KEY, createRobinhoodV4LiquidityMaterialization };
