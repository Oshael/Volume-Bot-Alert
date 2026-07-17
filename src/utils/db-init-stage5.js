const db = require('../models/db');

const TABLES = `
  CREATE TABLE IF NOT EXISTS token_catalog (
    id                        SERIAL PRIMARY KEY,
    address                   VARCHAR(64) NOT NULL,
    chain                     VARCHAR(32) NOT NULL DEFAULT 'solana',
    symbol                    VARCHAR(64),
    name                      VARCHAR(128),
    source                    VARCHAR(32) NOT NULL DEFAULT 'unknown',
    first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_mcap                 NUMERIC(20, 2),
    last_price                NUMERIC(20, 12),
    last_pair_address         VARCHAR(128),
    last_pair_url             TEXT,
    last_dex_id               VARCHAR(64),
    last_image_url            TEXT,
    last_twitter_url          TEXT,
    last_community_url        TEXT,
    is_active_monitor_candidate BOOLEAN NOT NULL DEFAULT TRUE,
    metadata_updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain, address)
  );

  CREATE INDEX IF NOT EXISTS idx_token_catalog_chain
    ON token_catalog(chain);

  CREATE INDEX IF NOT EXISTS idx_token_catalog_last_seen
    ON token_catalog(last_seen_at DESC);

  CREATE INDEX IF NOT EXISTS idx_token_catalog_active_candidate
    ON token_catalog(is_active_monitor_candidate);
`;

async function init() {
  try {
    await db.query(TABLES);
    console.log('Stage 5 tables created successfully');
    console.log('   - token_catalog');
  } catch (err) {
    console.error('Failed to create stage 5 tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
