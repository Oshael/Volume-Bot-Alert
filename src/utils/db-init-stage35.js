const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mock_trading_accounts (
     user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     starting_cash_usd NUMERIC(20, 6) NOT NULL,
     cash_usd NUMERIC(20, 6) NOT NULL,
     realized_pnl_usd NUMERIC(20, 6) NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS mock_trading_positions (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_address VARCHAR(64) NOT NULL,
     quantity NUMERIC(36, 18) NOT NULL,
     avg_entry_price_usd NUMERIC(20, 12) NOT NULL,
     avg_entry_mcap_usd NUMERIC(20, 2),
     cost_basis_usd NUMERIC(20, 6) NOT NULL,
     realized_pnl_usd NUMERIC(20, 6) NOT NULL DEFAULT 0,
     opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_positions_user_updated
     ON mock_trading_positions(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_positions_token_updated
     ON mock_trading_positions(token_address, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mock_trading_trades (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_address VARCHAR(64) NOT NULL,
     side VARCHAR(8) NOT NULL CHECK (side IN ('buy', 'sell')),
     quantity NUMERIC(36, 18) NOT NULL CHECK (quantity > 0),
     price_usd NUMERIC(20, 12) NOT NULL CHECK (price_usd > 0),
     market_cap_usd NUMERIC(20, 2),
     notional_usd NUMERIC(20, 6) NOT NULL CHECK (notional_usd > 0),
     realized_pnl_usd NUMERIC(20, 6) NOT NULL DEFAULT 0,
     realized_pnl_pct NUMERIC(20, 8),
     price_return_pct NUMERIC(20, 8),
     price_multiple NUMERIC(20, 8),
     mcap_multiple NUMERIC(20, 8),
     source VARCHAR(32) NOT NULL DEFAULT 'token_catalog',
     executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_trades_user_executed
     ON mock_trading_trades(user_id, executed_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_trades_user_token_executed
     ON mock_trading_trades(user_id, token_address, executed_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_trades_token_executed
     ON mock_trading_trades(token_address, executed_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mock_trading_take_profit_orders (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_address VARCHAR(64) NOT NULL,
     target_mcap_usd NUMERIC(20, 2) NOT NULL CHECK (target_mcap_usd > 0),
     sell_percent NUMERIC(8, 4) NOT NULL DEFAULT 100 CHECK (sell_percent > 0 AND sell_percent <= 100),
     status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triggered', 'cancelled')),
     triggered_trade_id INTEGER REFERENCES mock_trading_trades(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     triggered_at TIMESTAMPTZ,
     cancelled_at TIMESTAMPTZ,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `DROP INDEX IF EXISTS idx_mock_trading_take_profit_orders_open_unique`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_take_profit_orders_open_token
     ON mock_trading_take_profit_orders(user_id, token_address, updated_at DESC, id DESC)
     WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_take_profit_orders_open_target
     ON mock_trading_take_profit_orders(status, target_mcap_usd, updated_at)
     WHERE status = 'open'`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 35 mock trading tables created successfully');
    console.log('   - mock_trading_accounts');
    console.log('   - mock_trading_positions');
    console.log('   - mock_trading_trades');
    console.log('   - mock_trading_take_profit_orders');
  } catch (err) {
    console.error('Failed to create stage 35 mock trading tables:', err.message);
    process.exit(1);
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  init();
}

module.exports = { init, STATEMENTS };
