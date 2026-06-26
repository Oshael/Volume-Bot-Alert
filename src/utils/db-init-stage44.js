/**
 * Stage 44 - Token-gated wallet access foundation.
 * Run with: node src/utils/db-init-stage44.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_wallets (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     wallet_address VARCHAR(64) NOT NULL,
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     wallet_provider VARCHAR(64),
     is_primary BOOLEAN NOT NULL DEFAULT true,
     linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_login_at TIMESTAMPTZ,
     last_verified_at TIMESTAMPTZ,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_wallet_address
     ON user_wallets(wallet_address)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_user_id
     ON user_wallets(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_wallets_user_linked
     ON user_wallets(user_id, linked_at DESC)`,

  `CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
     id SERIAL PRIMARY KEY,
     wallet_address VARCHAR(64) NOT NULL,
     nonce_hash VARCHAR(255) NOT NULL,
     message_hash VARCHAR(255) NOT NULL,
     issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     consumed_at TIMESTAMPTZ,
     ip_address VARCHAR(45),
     user_agent TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_auth_challenges_nonce_hash
     ON wallet_auth_challenges(nonce_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_auth_challenges_wallet_expires
     ON wallet_auth_challenges(wallet_address, expires_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_auth_challenges_cleanup
     ON wallet_auth_challenges(expires_at, consumed_at)`,

  `CREATE TABLE IF NOT EXISTS token_holding_snapshots (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     wallet_address VARCHAR(64) NOT NULL,
     mint_address VARCHAR(64) NOT NULL,
     token_program VARCHAR(128),
     decimals INTEGER NOT NULL,
     balance_raw TEXT NOT NULL,
     balance_ui_string TEXT,
     tier VARCHAR(32) NOT NULL DEFAULT 'none',
     discount_percent INTEGER NOT NULL DEFAULT 0,
     has_unlimited_access BOOLEAN NOT NULL DEFAULT false,
     has_launch_promo_access BOOLEAN NOT NULL DEFAULT false,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     rpc_provider VARCHAR(64),
     rpc_slot BIGINT,
     rpc_error TEXT,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_holding_snapshots_user_checked
     ON token_holding_snapshots(user_id, checked_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_holding_snapshots_wallet_mint_checked
     ON token_holding_snapshots(wallet_address, mint_address, checked_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_holding_snapshots_expires
     ON token_holding_snapshots(expires_at)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 44 token-gated wallet access foundation applied successfully');
    console.log('   - user_wallets');
    console.log('   - wallet_auth_challenges');
    console.log('   - token_holding_snapshots');
  } catch (err) {
    console.error('Failed to apply stage 44 token-gated wallet access foundation:', err.message);
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
