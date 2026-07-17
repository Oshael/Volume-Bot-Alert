/**
 * Stage 45 - Manual token folders.
 * Run with: node src/utils/db-init-stage45.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_token_folders (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     parent_folder_id INTEGER REFERENCES user_token_folders(id) ON DELETE CASCADE,
     name VARCHAR(80) NOT NULL,
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CHECK (parent_folder_id IS NULL OR parent_folder_id <> id),
     UNIQUE (user_id, id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_token_folders_root_name
     ON user_token_folders(user_id, lower(name))
     WHERE parent_folder_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_token_folders_sibling_name
     ON user_token_folders(user_id, parent_folder_id, lower(name))
     WHERE parent_folder_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_user_token_folders_parent
     ON user_token_folders(user_id, parent_folder_id, sort_order, name)`,

  `CREATE TABLE IF NOT EXISTS user_token_folder_items (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     folder_id INTEGER NOT NULL,
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     address VARCHAR(64) NOT NULL,
     sort_order INTEGER NOT NULL DEFAULT 0,
     added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT user_token_folder_items_chain_pkey PRIMARY KEY (user_id, folder_id, chain, address),
     FOREIGN KEY (user_id, folder_id)
       REFERENCES user_token_folders(user_id, id)
       ON DELETE CASCADE,
     CONSTRAINT user_token_folder_items_user_chain_address_fkey FOREIGN KEY (user_id, chain, address)
       REFERENCES user_tokens(user_id, chain, address)
       ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_token_folder_items_folder
     ON user_token_folder_items(user_id, folder_id, sort_order, added_at)`,
  `CREATE INDEX IF NOT EXISTS idx_user_token_folder_items_address
     ON user_token_folder_items(user_id, address)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 45 manual token folders applied successfully');
    console.log('   - user_token_folders');
    console.log('   - user_token_folder_items');
  } catch (err) {
    console.error('Failed to apply stage 45 manual token folders:', err.message);
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
