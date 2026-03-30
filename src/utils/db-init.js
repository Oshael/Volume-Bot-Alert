/**
 * Database initialization script.
 * Run with: npm run db:init
 * Creates all tables if they don't exist. Safe to run multiple times.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1';
}

const poolConfig = {};

if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  poolConfig.connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
} else {
  poolConfig.host = process.env.DB_HOST;
  poolConfig.port = parseInt(process.env.DB_PORT, 10) || 5432;
  poolConfig.database = process.env.DB_NAME;
  poolConfig.user = process.env.DB_USER;
  poolConfig.password = process.env.DB_PASSWORD;
}

if (parseBoolean(process.env.DB_SSL, false) || process.env.PGSSLMODE === 'require') {
  poolConfig.ssl = {
    rejectUnauthorized: parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED, false),
  };
}

const pool = new Pool(poolConfig);

const schema = `
-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'user',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_email_verified BOOLEAN NOT NULL DEFAULT false,
  email_verified_at TIMESTAMPTZ,
  access_status VARCHAR(16) NOT NULL DEFAULT 'inactive',
  access_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_expires_at TIMESTAMPTZ,
  access_source VARCHAR(16) NOT NULL DEFAULT 'manual',
  access_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite_code   VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status VARCHAR(16) NOT NULL DEFAULT 'inactive';
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_source VARCHAR(16) NOT NULL DEFAULT 'manual';
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ALTER COLUMN access_status SET DEFAULT 'inactive';
ALTER TABLE users ALTER COLUMN access_granted_at SET DEFAULT NOW();
ALTER TABLE users ALTER COLUMN access_source SET DEFAULT 'manual';
ALTER TABLE users ALTER COLUMN access_updated_at SET DEFAULT NOW();

-- Index for login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_access_status ON users(access_status);
CREATE INDEX IF NOT EXISTS idx_users_access_expires_at ON users(access_expires_at);

-- Invite codes table
CREATE TABLE IF NOT EXISTS invites (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(64) UNIQUE NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_uses      INTEGER NOT NULL DEFAULT 1,
  use_count     INTEGER NOT NULL DEFAULT 0,
  grant_access_days INTEGER,
  grant_access_source VARCHAR(16) NOT NULL DEFAULT 'invite',
  expires_at    TIMESTAMPTZ NOT NULL,
  is_revoked    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE invites ADD COLUMN IF NOT EXISTS grant_access_days INTEGER;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS grant_access_source VARCHAR(16) NOT NULL DEFAULT 'invite';
ALTER TABLE invites ALTER COLUMN grant_access_source SET DEFAULT 'invite';

CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

-- Login attempts (for security auditing)
CREATE TABLE IF NOT EXISTS login_attempts (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255),
  ip_address    VARCHAR(45),
  success       BOOLEAN NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at);

-- Sessions (for tracking active sessions / forced logout)
CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL,
  ip_address    VARCHAR(45),
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  requested_ip  VARCHAR(45),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires ON email_verification_tokens(expires_at);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  requested_ip  VARCHAR(45),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);

-- Login email OTP challenges
CREATE TABLE IF NOT EXISTS login_email_otp_challenges (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash    VARCHAR(255) NOT NULL,
  code_hash         VARCHAR(255) NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  requested_ip      VARCHAR(45),
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_email_otp_challenges_user ON login_email_otp_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_login_email_otp_challenges_hash ON login_email_otp_challenges(challenge_hash);
CREATE INDEX IF NOT EXISTS idx_login_email_otp_challenges_expires ON login_email_otp_challenges(expires_at);

-- Billing orders
CREATE TABLE IF NOT EXISTS billing_orders (
  id                      SERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_key                VARCHAR(64) NOT NULL,
  plan_name               VARCHAR(128) NOT NULL,
  access_days             INTEGER NOT NULL,
  provider                VARCHAR(32) NOT NULL,
  provider_paylink_id     VARCHAR(128),
  provider_charge_id      VARCHAR(128),
  provider_charge_token   VARCHAR(128),
  provider_checkout_url   TEXT,
  provider_status         VARCHAR(32),
  currency_code           VARCHAR(16) NOT NULL,
  currency_amount_minor   BIGINT NOT NULL,
  status                  VARCHAR(32) NOT NULL DEFAULT 'pending',
  checkout_expires_at     TIMESTAMPTZ,
  paid_at                 TIMESTAMPTZ,
  last_error              TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_orders_user ON billing_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_orders_provider_charge_id
  ON billing_orders(provider, provider_charge_id)
  WHERE provider_charge_id IS NOT NULL;

-- Billing webhook/events
CREATE TABLE IF NOT EXISTS billing_events (
  id                            SERIAL PRIMARY KEY,
  order_id                      INTEGER REFERENCES billing_orders(id) ON DELETE SET NULL,
  provider                      VARCHAR(32) NOT NULL,
  event_type                    VARCHAR(64) NOT NULL,
  provider_event_id             VARCHAR(128),
  delivery_idempotency_key      VARCHAR(255),
  transaction_idempotency_key   VARCHAR(255),
  process_status                VARCHAR(32) NOT NULL DEFAULT 'received',
  payload                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_billing_events_order ON billing_events(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_events_provider ON billing_events(provider, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_delivery_key
  ON billing_events(provider, delivery_idempotency_key)
  WHERE delivery_idempotency_key IS NOT NULL;
`;

async function init() {
  console.log('Initializing database...');
  try {
    await pool.query(schema);
    console.log('All tables created successfully.');

    // Check if admin exists
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (rows.length === 0) {
      console.log('');
      console.log('No admin user found.');
      console.log('Create one by registering with an invite code,');
      console.log('then manually promote via SQL:');
      console.log("UPDATE users SET role = 'admin' WHERE username = 'your_username';");
      console.log('');
      console.log('Or generate a bootstrap invite:');
      console.log('npm run invite:create');
    }
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();
