/**
 * Stage 54 - Promote user token preferences to chain-aware identities.
 * Run with: node src/utils/db-init-stage54.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `DO $migration$
   DECLARE table_name TEXT;
   BEGIN
     FOREACH table_name IN ARRAY ARRAY[
       'user_tokens', 'user_starred_tokens', 'user_pinned_monitored_tokens',
       'user_bootstrap_tokens', 'user_token_folder_items'
     ] LOOP
       EXECUTE format(
         'ALTER TABLE %I ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT ''solana''',
         table_name
       );
       EXECUTE format(
         'ALTER TABLE %I ALTER COLUMN chain SET DEFAULT ''solana'', ALTER COLUMN chain SET NOT NULL',
         table_name
       );
     END LOOP;
   END
   $migration$`,
  `DO $index$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_user_chain_address_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_chain_identity
         ON user_tokens(user_id, chain, address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_starred_tokens_user_chain_address_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_starred_tokens_chain_identity
         ON user_starred_tokens(user_id, chain, address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_pinned_tokens_user_chain_address_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_pinned_tokens_chain_identity
         ON user_pinned_monitored_tokens(user_id, chain, address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_bootstrap_tokens_user_chain_address_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_bootstrap_tokens_chain_identity
         ON user_bootstrap_tokens(user_id, chain, address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_token_folder_items_chain_pkey') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_token_folder_items_chain_identity
         ON user_token_folder_items(user_id, folder_id, chain, address);
     END IF;
   END
   $index$`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_user_chain_address_key') THEN
       ALTER TABLE user_tokens
         ADD CONSTRAINT user_tokens_user_chain_address_key
         UNIQUE USING INDEX idx_user_tokens_chain_identity;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_starred_tokens_user_chain_address_key') THEN
       ALTER TABLE user_starred_tokens
         ADD CONSTRAINT user_starred_tokens_user_chain_address_key
         UNIQUE USING INDEX idx_user_starred_tokens_chain_identity;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_pinned_tokens_user_chain_address_key') THEN
       ALTER TABLE user_pinned_monitored_tokens
         ADD CONSTRAINT user_pinned_tokens_user_chain_address_key
         UNIQUE USING INDEX idx_user_pinned_tokens_chain_identity;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_bootstrap_tokens_user_chain_address_key') THEN
       ALTER TABLE user_bootstrap_tokens
         ADD CONSTRAINT user_bootstrap_tokens_user_chain_address_key
         UNIQUE USING INDEX idx_user_bootstrap_tokens_chain_identity;
     END IF;

     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_token_folder_items_user_chain_address_fkey') THEN
       ALTER TABLE user_token_folder_items
         ADD CONSTRAINT user_token_folder_items_user_chain_address_fkey
         FOREIGN KEY (user_id, chain, address)
         REFERENCES user_tokens(user_id, chain, address)
         ON DELETE CASCADE NOT VALID;
     END IF;
     ALTER TABLE user_token_folder_items
       VALIDATE CONSTRAINT user_token_folder_items_user_chain_address_fkey;

     ALTER TABLE user_token_folder_items
       DROP CONSTRAINT IF EXISTS user_token_folder_items_user_id_address_fkey;
     ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_user_id_address_key;
     ALTER TABLE user_starred_tokens DROP CONSTRAINT IF EXISTS user_starred_tokens_user_id_address_key;
     ALTER TABLE user_pinned_monitored_tokens
       DROP CONSTRAINT IF EXISTS user_pinned_monitored_tokens_user_id_address_key;
     ALTER TABLE user_bootstrap_tokens DROP CONSTRAINT IF EXISTS user_bootstrap_tokens_user_id_address_key;

     ALTER TABLE user_token_folder_items DROP CONSTRAINT IF EXISTS user_token_folder_items_pkey;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_token_folder_items_chain_pkey') THEN
       ALTER TABLE user_token_folder_items
         ADD CONSTRAINT user_token_folder_items_chain_pkey
         PRIMARY KEY USING INDEX idx_user_token_folder_items_chain_identity;
     END IF;
   END
   $migration$`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 54 chain-aware user token preferences applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 54 user token preferences:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
