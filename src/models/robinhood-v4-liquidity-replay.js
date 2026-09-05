const db = require('./db');

const PROCESSING_LEASE_KEY = 'robinhood-processing-worker';
const RECONCILIATION_LOCK_KEY = 'robinhood-v4-liquidity-reconciliation';

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function stateRow(row) {
  return row ? {
    startBlock: String(row.start_block),
    nextBlock: String(row.next_block),
    targetBlock: String(row.target_block),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    status: row.status,
    version: String(row.version),
  } : null;
}

function eventRow(event) {
  if (event?.kind !== 'modify-liquidity' || event.protocol !== 'uniswap-v4') {
    throw new Error('Only decoded Uniswap V4 ModifyLiquidity events can be replayed');
  }
  const observedAt = new Date(Number(event.timestampMs));
  if (!Number.isFinite(observedAt.getTime())) throw new Error('event.timestampMs is invalid');
  return {
    transactionHash: event.transactionHash,
    logIndex: quantity(event.logIndex, 'event.logIndex'),
    blockNumber: quantity(event.blockNumber, 'event.blockNumber'),
    blockHash: event.blockHash,
    poolId: event.poolId,
    marketKey: event.marketKey,
    sender: event.sender,
    tickLower: event.tickLower,
    tickUpper: event.tickUpper,
    liquidityDelta: event.liquidityDelta,
    salt: event.salt,
    observedAt,
  };
}

function createRobinhoodV4LiquidityReplayRepository(options = {}) {
  const database = options.database || db;

  async function ensureState(targetValue, input = {}) {
    const targetBlock = quantity(targetValue, 'targetBlock');
    const pools = await database.query(
      `SELECT pool_id, market_key, token_address, quote_address, tick_spacing,
              origin_address, discovery_block
       FROM robinhood_pool_registry
       WHERE chain = 'robinhood' AND protocol = 'uniswap-v4'
       ORDER BY discovery_block, pool_id`
    );
    if (!pools.rowCount) throw new Error('No Robinhood V4 pools are registered');
    const startBlock = String(pools.rows[0].discovery_block);
    if (BigInt(targetBlock) < BigInt(startBlock)) throw new Error('Replay target precedes V4 discovery');
    await database.query(
      `INSERT INTO robinhood_v4_liquidity_replay_state (
         chain, start_block, next_block, target_block
       ) VALUES ('robinhood', $1, $1, $2)
       ON CONFLICT (chain) DO NOTHING`,
      [startBlock, targetBlock]
    );
    if (input.restart === true) {
      const client = await database.getClient();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [RECONCILIATION_LOCK_KEY]);
        const processing = await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM worker_leases WHERE lease_key = $1 AND lease_until > NOW()
           ) AS active`,
          [PROCESSING_LEASE_KEY]
        );
        if (processing.rows[0]?.active === true) {
          throw new Error('Robinhood processing worker must be stopped before reconciliation');
        }
        const frontier = await client.query(
          `SELECT MIN(block_number) AS block_number
             FROM robinhood_head_captures
            WHERE chain = 'robinhood'
              AND processing_status IN ('pending', 'leased', 'blocked')`
        );
        const firstActive = frontier.rows[0]?.block_number;
        if (firstActive != null && BigInt(targetBlock) >= BigInt(firstActive)) {
          throw new Error(`Reconciliation target must precede active capture ${firstActive}`);
        }
        await client.query(
          `UPDATE robinhood_v4_liquidity_replay_state
              SET start_block = $1, next_block = $1, target_block = $2,
                  checkpoint_block = NULL, checkpoint_hash = NULL,
                  status = 'running', version = version + 1, updated_at = NOW()
            WHERE chain = 'robinhood'`,
          [startBlock, targetBlock]
        );
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
      } finally {
        client.release();
      }
    }
    const loaded = await database.query(
      `SELECT * FROM robinhood_v4_liquidity_replay_state WHERE chain = 'robinhood'`
    );
    return {
      state: stateRow(loaded.rows[0]),
      pools: pools.rows.map((row) => ({
        poolId: row.pool_id,
        marketKey: row.market_key,
        tokenAddress: row.token_address,
        quoteAddress: row.quote_address,
        tickSpacing: Number(row.tick_spacing),
        poolManagerAddress: row.origin_address,
      })),
    };
  }

  async function commitRange(input = {}) {
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const toBlock = quantity(input.toBlock, 'toBlock');
    if (BigInt(toBlock) < BigInt(fromBlock)) throw new Error('Replay range is inverted');
    const checkpointHash = String(input.checkpointHash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(checkpointHash)) throw new Error('checkpointHash is invalid');
    const rows = (input.events || []).map(eventRow);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const processing = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM worker_leases WHERE lease_key = $1 AND lease_until > NOW()
         ) AS active`,
        [PROCESSING_LEASE_KEY]
      );
      if (processing.rows[0]?.active === true) {
        throw new Error('Robinhood processing worker must remain stopped during replay');
      }
      if (rows.length) {
        const written = await client.query(
          `INSERT INTO robinhood_v4_liquidity_deltas (
             chain, transaction_hash, log_index, block_number, block_hash,
             pool_id, market_key, sender, tick_lower, tick_upper,
             liquidity_delta, salt, observed_at
           ) SELECT 'robinhood', "transactionHash", "logIndex"::bigint,
                    "blockNumber"::bigint, "blockHash", "poolId", "marketKey", sender,
                    "tickLower", "tickUpper", "liquidityDelta"::numeric, salt, "observedAt"
             FROM jsonb_to_recordset($1::jsonb) AS event(
               "transactionHash" text, "logIndex" text, "blockNumber" text,
               "blockHash" text, "poolId" text, "marketKey" text, sender text,
               "tickLower" int, "tickUpper" int, "liquidityDelta" text,
               salt text, "observedAt" timestamptz)
           ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE
             SET transaction_hash = EXCLUDED.transaction_hash
             WHERE robinhood_v4_liquidity_deltas.block_number = EXCLUDED.block_number
               AND robinhood_v4_liquidity_deltas.block_hash = EXCLUDED.block_hash
               AND robinhood_v4_liquidity_deltas.pool_id = EXCLUDED.pool_id
               AND robinhood_v4_liquidity_deltas.market_key = EXCLUDED.market_key
               AND robinhood_v4_liquidity_deltas.sender = EXCLUDED.sender
               AND robinhood_v4_liquidity_deltas.tick_lower = EXCLUDED.tick_lower
               AND robinhood_v4_liquidity_deltas.tick_upper = EXCLUDED.tick_upper
               AND robinhood_v4_liquidity_deltas.liquidity_delta = EXCLUDED.liquidity_delta
               AND robinhood_v4_liquidity_deltas.salt = EXCLUDED.salt
               AND robinhood_v4_liquidity_deltas.observed_at = EXCLUDED.observed_at
           RETURNING transaction_hash`,
          [JSON.stringify(rows)]
        );
        if (written.rowCount !== rows.length) throw new Error('Replay conflicts with persisted V4 liquidity');
      }
      const advanced = await client.query(
        `UPDATE robinhood_v4_liquidity_replay_state
         SET next_block = $2::bigint + 1,
             checkpoint_block = $2,
             checkpoint_hash = $3,
             status = CASE WHEN $2 >= target_block THEN 'completed' ELSE 'running' END,
             version = version + 1,
             updated_at = NOW()
         WHERE chain = 'robinhood' AND next_block = $1 AND target_block >= $2
         RETURNING *`,
        [fromBlock, toBlock, checkpointHash]
      );
      if (advanced.rowCount !== 1) throw new Error('V4 liquidity replay cursor changed or has a gap');
      await client.query('COMMIT');
      return { state: stateRow(advanced.rows[0]), persisted: rows.length };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ ensureState, commitRange });
}

module.exports = { createRobinhoodV4LiquidityReplayRepository, __private: { eventRow, stateRow } };
