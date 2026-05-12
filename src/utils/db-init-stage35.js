const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mock_trading_wallets (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name VARCHAR(80) NOT NULL,
     sort_order INTEGER NOT NULL DEFAULT 0,
     is_default BOOLEAN NOT NULL DEFAULT false,
     archived_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mock_trading_wallets_user_default
     ON mock_trading_wallets(user_id)
     WHERE is_default = true AND archived_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mock_trading_wallets_user_active_name
     ON mock_trading_wallets(user_id, lower(name))
     WHERE archived_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_wallets_user_sort
     ON mock_trading_wallets(user_id, sort_order ASC, id ASC)
     WHERE archived_at IS NULL`,
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
  `ALTER TABLE mock_trading_accounts
     ADD COLUMN IF NOT EXISTS wallet_id INTEGER`,
  `ALTER TABLE mock_trading_positions
     ADD COLUMN IF NOT EXISTS wallet_id INTEGER`,
  `ALTER TABLE mock_trading_trades
     ADD COLUMN IF NOT EXISTS wallet_id INTEGER`,
  `ALTER TABLE mock_trading_take_profit_orders
     ADD COLUMN IF NOT EXISTS wallet_id INTEGER`,
  `INSERT INTO mock_trading_wallets (user_id, name, sort_order, is_default)
     SELECT source_users.user_id, 'Main', 0, true
     FROM (
       SELECT user_id FROM mock_trading_accounts
       UNION
       SELECT user_id FROM mock_trading_positions
       UNION
       SELECT user_id FROM mock_trading_trades
       UNION
       SELECT user_id FROM mock_trading_take_profit_orders
     ) source_users
     WHERE NOT EXISTS (
       SELECT 1
       FROM mock_trading_wallets existing_wallet
       WHERE existing_wallet.user_id = source_users.user_id
         AND existing_wallet.is_default = true
         AND existing_wallet.archived_at IS NULL
     )
     ON CONFLICT DO NOTHING`,
  `UPDATE mock_trading_wallets wallet
     SET is_default = true,
         updated_at = NOW()
     FROM (
       SELECT DISTINCT ON (active_wallet.user_id)
         active_wallet.id,
         active_wallet.user_id
       FROM mock_trading_wallets active_wallet
       WHERE active_wallet.archived_at IS NULL
       ORDER BY active_wallet.user_id ASC, active_wallet.sort_order ASC, active_wallet.id ASC
     ) first_wallet
     WHERE wallet.id = first_wallet.id
       AND NOT EXISTS (
         SELECT 1
         FROM mock_trading_wallets default_wallet
         WHERE default_wallet.user_id = first_wallet.user_id
           AND default_wallet.is_default = true
           AND default_wallet.archived_at IS NULL
       )`,
  `UPDATE mock_trading_accounts account
     SET wallet_id = wallet.id
     FROM mock_trading_wallets wallet
     WHERE account.wallet_id IS NULL
       AND wallet.user_id = account.user_id
       AND wallet.is_default = true
       AND wallet.archived_at IS NULL`,
  `UPDATE mock_trading_positions position
     SET wallet_id = wallet.id
     FROM mock_trading_wallets wallet
     WHERE position.wallet_id IS NULL
       AND wallet.user_id = position.user_id
       AND wallet.is_default = true
       AND wallet.archived_at IS NULL`,
  `UPDATE mock_trading_trades trade
     SET wallet_id = wallet.id
     FROM mock_trading_wallets wallet
     WHERE trade.wallet_id IS NULL
       AND wallet.user_id = trade.user_id
       AND wallet.is_default = true
       AND wallet.archived_at IS NULL`,
  `UPDATE mock_trading_take_profit_orders take_profit_order
     SET wallet_id = wallet.id
     FROM mock_trading_wallets wallet
     WHERE take_profit_order.wallet_id IS NULL
       AND wallet.user_id = take_profit_order.user_id
       AND wallet.is_default = true
       AND wallet.archived_at IS NULL`,
  `CREATE OR REPLACE FUNCTION ensure_mock_trading_default_wallet_id(target_user_id INTEGER)
     RETURNS INTEGER AS $$
     DECLARE
       resolved_wallet_id INTEGER;
     BEGIN
       SELECT id
         INTO resolved_wallet_id
       FROM mock_trading_wallets
       WHERE user_id = target_user_id
         AND is_default = true
         AND archived_at IS NULL
       ORDER BY id ASC
       LIMIT 1;

       IF resolved_wallet_id IS NULL THEN
         INSERT INTO mock_trading_wallets (user_id, name, sort_order, is_default)
         VALUES (target_user_id, 'Main', 0, true)
         ON CONFLICT DO NOTHING;

         IF NOT EXISTS (
           SELECT 1
           FROM mock_trading_wallets
           WHERE user_id = target_user_id
             AND is_default = true
             AND archived_at IS NULL
         ) THEN
           UPDATE mock_trading_wallets
             SET is_default = true,
                 updated_at = NOW()
           WHERE id = (
             SELECT id
             FROM mock_trading_wallets
             WHERE user_id = target_user_id
               AND archived_at IS NULL
             ORDER BY sort_order ASC, id ASC
             LIMIT 1
           );
         END IF;

         SELECT id
           INTO resolved_wallet_id
         FROM mock_trading_wallets
         WHERE user_id = target_user_id
           AND is_default = true
           AND archived_at IS NULL
         ORDER BY id ASC
         LIMIT 1;
       END IF;

       RETURN resolved_wallet_id;
     END;
     $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION set_mock_trading_wallet_id()
     RETURNS TRIGGER AS $$
     BEGIN
       IF NEW.wallet_id IS NULL THEN
         NEW.wallet_id := ensure_mock_trading_default_wallet_id(NEW.user_id);
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_mock_trading_accounts_wallet_id ON mock_trading_accounts`,
  `CREATE TRIGGER trg_mock_trading_accounts_wallet_id
     BEFORE INSERT ON mock_trading_accounts
     FOR EACH ROW
     EXECUTE FUNCTION set_mock_trading_wallet_id()`,
  `DROP TRIGGER IF EXISTS trg_mock_trading_positions_wallet_id ON mock_trading_positions`,
  `CREATE TRIGGER trg_mock_trading_positions_wallet_id
     BEFORE INSERT ON mock_trading_positions
     FOR EACH ROW
     EXECUTE FUNCTION set_mock_trading_wallet_id()`,
  `DROP TRIGGER IF EXISTS trg_mock_trading_trades_wallet_id ON mock_trading_trades`,
  `CREATE TRIGGER trg_mock_trading_trades_wallet_id
     BEFORE INSERT ON mock_trading_trades
     FOR EACH ROW
     EXECUTE FUNCTION set_mock_trading_wallet_id()`,
  `DROP TRIGGER IF EXISTS trg_mock_trading_take_profit_orders_wallet_id ON mock_trading_take_profit_orders`,
  `CREATE TRIGGER trg_mock_trading_take_profit_orders_wallet_id
     BEFORE INSERT ON mock_trading_take_profit_orders
     FOR EACH ROW
     EXECUTE FUNCTION set_mock_trading_wallet_id()`,
  `ALTER TABLE mock_trading_accounts
     ALTER COLUMN wallet_id SET NOT NULL`,
  `ALTER TABLE mock_trading_positions
     ALTER COLUMN wallet_id SET NOT NULL`,
  `ALTER TABLE mock_trading_trades
     ALTER COLUMN wallet_id SET NOT NULL`,
  `ALTER TABLE mock_trading_take_profit_orders
     ALTER COLUMN wallet_id SET NOT NULL`,
  `ALTER TABLE mock_trading_accounts
     DROP CONSTRAINT IF EXISTS mock_trading_accounts_pkey`,
  `ALTER TABLE mock_trading_accounts
     ADD CONSTRAINT mock_trading_accounts_pkey PRIMARY KEY (wallet_id)`,
  `ALTER TABLE mock_trading_positions
     DROP CONSTRAINT IF EXISTS mock_trading_positions_pkey`,
  `ALTER TABLE mock_trading_positions
     ADD CONSTRAINT mock_trading_positions_pkey PRIMARY KEY (wallet_id, token_address)`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'mock_trading_accounts_wallet_id_fkey'
     ) THEN
       ALTER TABLE mock_trading_accounts
         ADD CONSTRAINT mock_trading_accounts_wallet_id_fkey
         FOREIGN KEY (wallet_id) REFERENCES mock_trading_wallets(id) ON DELETE CASCADE;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'mock_trading_positions_wallet_id_fkey'
     ) THEN
       ALTER TABLE mock_trading_positions
         ADD CONSTRAINT mock_trading_positions_wallet_id_fkey
         FOREIGN KEY (wallet_id) REFERENCES mock_trading_wallets(id) ON DELETE CASCADE;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'mock_trading_trades_wallet_id_fkey'
     ) THEN
       ALTER TABLE mock_trading_trades
         ADD CONSTRAINT mock_trading_trades_wallet_id_fkey
         FOREIGN KEY (wallet_id) REFERENCES mock_trading_wallets(id) ON DELETE CASCADE;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'mock_trading_take_profit_orders_wallet_id_fkey'
     ) THEN
       ALTER TABLE mock_trading_take_profit_orders
         ADD CONSTRAINT mock_trading_take_profit_orders_wallet_id_fkey
         FOREIGN KEY (wallet_id) REFERENCES mock_trading_wallets(id) ON DELETE CASCADE;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mock_trading_accounts_wallet
     ON mock_trading_accounts(wallet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_accounts_user
     ON mock_trading_accounts(user_id, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mock_trading_positions_wallet_token
     ON mock_trading_positions(wallet_id, token_address)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_positions_wallet_updated
     ON mock_trading_positions(wallet_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_trades_wallet_executed
     ON mock_trading_trades(wallet_id, executed_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_trades_wallet_token_executed
     ON mock_trading_trades(wallet_id, token_address, executed_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_take_profit_orders_wallet_open_token
     ON mock_trading_take_profit_orders(wallet_id, token_address, updated_at DESC, id DESC)
     WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_mock_trading_take_profit_orders_wallet_open_target
     ON mock_trading_take_profit_orders(wallet_id, status, target_mcap_usd, updated_at)
     WHERE status = 'open'`,
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
    console.log('   - mock_trading_wallets');
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
