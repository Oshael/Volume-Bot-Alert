'use strict';

// Stage 124: X ingestion store (Bloco 3, data layer). Additive and inert until
// the ingestion worker (later slice) is wired and enabled. The scraping layer
// writes x_post / x_post_media; downstream consumers (fingerprint, OCR, trend,
// matcher) read from there. Sessions, lists and tracked accounts are rows so
// scaling is inserting rows, not deploying code.

const db = require('../models/db');

const STATEMENTS = [
  // Scraping identities (who we observe with) + fixed proxy per session.
  `CREATE TABLE IF NOT EXISTS x_session (
     id                SERIAL PRIMARY KEY,
     label             VARCHAR(64) NOT NULL,
     auth_token        TEXT NOT NULL,
     ct0               TEXT NOT NULL,
     proxy_url         TEXT,
     enabled           BOOLEAN NOT NULL DEFAULT TRUE,
     quarantined_until TIMESTAMPTZ,
     last_used_at      TIMESTAMPTZ,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_x_session_enabled ON x_session(enabled, quarantined_until)`,

  // Lists we poll (the firehose target). Cursor folded in to avoid a side table.
  `CREATE TABLE IF NOT EXISTS x_list (
     id             SERIAL PRIMARY KEY,
     list_id        VARCHAR(32) NOT NULL UNIQUE,
     query_id       VARCHAR(64),
     label          VARCHAR(64),
     enabled        BOOLEAN NOT NULL DEFAULT TRUE,
     last_cursor    TEXT,
     last_polled_at TIMESTAMPTZ,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Monitored accounts (who we watch). tier drives single-post rights vs trend.
  `CREATE TABLE IF NOT EXISTS x_tracked_account (
     rest_id           VARCHAR(32) PRIMARY KEY,
     screen_name       VARCHAR(64),
     followers         BIGINT,
     tier              VARCHAR(16) NOT NULL DEFAULT 'trend',
     enabled           BOOLEAN NOT NULL DEFAULT TRUE,
     added_reason      TEXT,
     added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_post_at TIMESTAMPTZ
   )`,

  // Observed posts, short retention. Dedupe by post_id.
  `CREATE TABLE IF NOT EXISTS x_post (
     post_id            VARCHAR(32) PRIMARY KEY,
     author_rest_id     VARCHAR(32),
     author_screen_name VARCHAR(64),
     author_followers   BIGINT,
     text               TEXT,
     lang               VARCHAR(16),
     posted_at          TIMESTAMPTZ,
     retweet_of_post_id VARCHAR(32),
     engagement         JSONB NOT NULL DEFAULT '{}'::jsonb,
     ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_x_post_ingested ON x_post(ingested_at)`,
  `CREATE INDEX IF NOT EXISTS idx_x_post_author ON x_post(author_rest_id, posted_at DESC)`,

  `CREATE TABLE IF NOT EXISTS x_post_media (
     post_id     VARCHAR(32) NOT NULL,
     media_index SMALLINT NOT NULL,
     media_url   TEXT NOT NULL,
     media_type  VARCHAR(16),
     PRIMARY KEY (post_id, media_index)
   )`,
];

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 124 X ingestion store created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  init().catch((error) => {
    console.error('Failed to create Stage 124:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, init };
