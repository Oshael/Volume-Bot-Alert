/**
 * Etapa 16 - Billing foundation.
 * Rodar com: node src/utils/db-init-stage16.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS billing_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_key VARCHAR(64) NOT NULL,
    plan_name VARCHAR(128) NOT NULL,
    access_days INTEGER NOT NULL,
    provider VARCHAR(32) NOT NULL,
    provider_paylink_id VARCHAR(128),
    provider_charge_id VARCHAR(128),
    provider_charge_token VARCHAR(128),
    provider_checkout_url TEXT,
    provider_status VARCHAR(32),
    currency_code VARCHAR(16) NOT NULL,
    currency_amount_minor BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    checkout_expires_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_billing_orders_user ON billing_orders(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders(status, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_orders_provider_charge_id
     ON billing_orders(provider, provider_charge_id)
     WHERE provider_charge_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS billing_events (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES billing_orders(id) ON DELETE SET NULL,
    provider VARCHAR(32) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    provider_event_id VARCHAR(128),
    delivery_idempotency_key VARCHAR(255),
    transaction_idempotency_key VARCHAR(255),
    process_status VARCHAR(32) NOT NULL DEFAULT 'received',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_billing_events_order ON billing_events(order_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_events_provider ON billing_events(provider, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_delivery_key
     ON billing_events(provider, delivery_idempotency_key)
     WHERE delivery_idempotency_key IS NOT NULL`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 16 billing foundation created successfully');
    console.log('   - billing_orders');
    console.log('   - billing_events');
  } catch (err) {
    console.error('Failed to create stage 16 fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
