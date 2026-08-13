'use strict';

// Stage 123: token image fingerprints for the X-post/token match plan (Bloco 1).
// Stores the perceptual hashes of each catalog token image so the matcher can
// compare incoming X-post images in memory. Mirror columns hold the hash of the
// horizontally flipped image (pHash zeroes out under mirroring, a known failure
// mode measured in Bloco 0), computed at zero extra network cost. `ok` marks a
// decode/download failure so a dead URL is not retried on every cycle.

const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_image_fingerprint (
     chain            VARCHAR(32) NOT NULL,
     token_address    VARCHAR(64) NOT NULL,
     source_image_url TEXT NOT NULL,
     phash            BIGINT,
     dhash            BIGINT,
     phash_mirror     BIGINT,
     dhash_mirror     BIGINT,
     ok               BOOLEAN NOT NULL DEFAULT TRUE,
     computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (chain, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_image_fingerprint_computed
     ON token_image_fingerprint(computed_at DESC)`,
];

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 123 token_image_fingerprint created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  init().catch((error) => {
    console.error('Failed to create Stage 123:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, init };
