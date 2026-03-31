/**
 * Etapa 18 - Social identity linking foundation.
 * Rodar com: node src/utils/db-init-stage18.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_social_identities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL,
    provider_user_id VARCHAR(255) NOT NULL,
    provider_email VARCHAR(255),
    provider_email_verified BOOLEAN NOT NULL DEFAULT false,
    provider_display_name VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_social_identities_user ON user_social_identities(user_id, linked_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_social_identities_provider_identity
     ON user_social_identities(provider, provider_user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_social_identities_user_provider
     ON user_social_identities(user_id, provider)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 18 social identity foundation created successfully');
    console.log('   - user_social_identities');
  } catch (err) {
    console.error('Failed to create stage 18 fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
