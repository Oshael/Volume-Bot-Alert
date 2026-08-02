/**
 * Stage 98 - Allow Uniswap V3 TVL valued from the pool's ERC-20 balances.
 * Existing V3/V4 rows remain valid and nullable; V4 stays fail-closed.
 */
const db = require('../models/db');

function liquidityCheck(prefix = '') {
  const field = (name) => `${prefix}${name}`;
  return `(
    (${field('liquidity_usd')} IS NULL
      AND ${field('liquidity_raw')} IS NULL
      AND ${field('liquidity_status')} IS NULL
      AND ${field('liquidity_confidence')} IS NULL)
    OR (protocol = 'uniswap-v2' AND ${field('liquidity_raw')} IS NULL
      AND ((
        ${field('liquidity_status')} = 'spot_estimate_from_double_quote_reserve'
        AND ${field('liquidity_usd')} >= 0
        AND ${field('liquidity_confidence')} = 'medium'
      ) OR (
        ${field('liquidity_status')} = 'missing_v2_reserve_or_quote'
        AND ${field('liquidity_usd')} IS NULL
        AND ${field('liquidity_confidence')} = 'none'
      )))
    OR (protocol = 'uniswap-v3' AND ${field('liquidity_raw')} >= 0
      AND ((
        ${field('liquidity_status')} = 'spot_tvl_from_pool_balances'
        AND ${field('liquidity_usd')} >= 0
        AND ${field('liquidity_confidence')} = 'medium'
      ) OR (
        ${field('liquidity_status')} = 'requires_tick_liquidity_distribution'
        AND ${field('liquidity_usd')} IS NULL
        AND ${field('liquidity_confidence')} = 'none'
      )))
    OR (protocol = 'uniswap-v4'
      AND ${field('liquidity_usd')} IS NULL
      AND ${field('liquidity_raw')} >= 0
      AND ${field('liquidity_status')} = 'requires_tick_liquidity_distribution'
      AND ${field('liquidity_confidence')} = 'none')
  )`;
}

const TABLES = Object.freeze([
  {
    table: 'robinhood_market_observations',
    constraint: 'robinhood_market_observations_liquidity_protocol_check',
    prefix: '',
  },
  ...['robinhood_market_buckets_1m', 'robinhood_market_buckets_1h'].map((table) => ({
    table, constraint: `${table}_liquidity_check`, prefix: 'close_',
  })),
]);

const STATEMENTS = Object.freeze(TABLES.map(({ table, constraint, prefix }) => (
  `ALTER TABLE ${table}
     DROP CONSTRAINT IF EXISTS ${constraint},
     ADD CONSTRAINT ${constraint} CHECK ${liquidityCheck(prefix)}`
)));

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 98 Robinhood V3 pool-balance TVL enabled successfully');
  } catch (error) {
    console.error('Failed to enable Stage 98 Robinhood V3 TVL:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, TABLES, init, liquidityCheck };
