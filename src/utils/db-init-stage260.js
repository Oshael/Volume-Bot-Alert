'use strict';

const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_ranking_publications (
     chain VARCHAR(32) NOT NULL CHECK (chain='robinhood'),
     projection_version VARCHAR(64) NOT NULL,
     ranking_window VARCHAR(3) NOT NULL,
     generation BIGINT NOT NULL CHECK (generation>0),
     as_of TIMESTAMPTZ NOT NULL,
     checkpoint_block BIGINT NOT NULL CHECK (checkpoint_block>=0),
     checkpoint_hash VARCHAR(66) NOT NULL CHECK (checkpoint_hash ~ '^0x[0-9a-f]{64}$'),
     source_revisions JSONB NOT NULL,
     payload JSONB NOT NULL,
     published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
     CONSTRAINT rh_wallet_ranking_publications_pkey PRIMARY KEY (chain,projection_version,ranking_window),
     CONSTRAINT rh_wallet_ranking_publication_window CHECK (ranking_window IN ('24h','7d','30d','ALL')),
     CONSTRAINT rh_wallet_ranking_publication_revisions CHECK (
       jsonb_typeof(source_revisions)='object'
       AND source_revisions ?& ARRAY['positions','transfers','swaps','prices','reorg']),
     CONSTRAINT rh_wallet_ranking_publication_payload CHECK (
       jsonb_typeof(payload)='object' AND payload ? 'candidateUniverseComplete'
       AND payload->'candidateUniverseComplete'='true'::jsonb
       AND payload ? 'ranked' AND jsonb_typeof(payload->'ranked')='array'
       AND jsonb_array_length(payload->'ranked')<=100
       AND octet_length(payload::text)<=131072)
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end();
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Stage 260 wallet ranking publications failed:', error.message);
  process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
