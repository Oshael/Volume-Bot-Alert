/** Stage 160 - unresolved deployment evidence for directional transfer repairs. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_directional_transfer_deployment_gaps (
     range_id BIGINT NOT NULL
       REFERENCES robinhood_directional_transfer_replay_ranges(id) ON DELETE CASCADE,
     token_address VARCHAR(42) NOT NULL,
     last_error_code VARCHAR(64) NOT NULL
       DEFAULT 'directional_repair_deployment_unavailable',
     last_error_message VARCHAR(500) NOT NULL
       DEFAULT 'directional repair candidate has no exact deployment block',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_directional_transfer_deployment_gaps_pkey
       PRIMARY KEY (range_id, token_address),
     CONSTRAINT rh_directional_transfer_deployment_gaps_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_directional_transfer_deployment_gaps_error_check CHECK (
       last_error_code = 'directional_repair_deployment_unavailable'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_directional_transfer_deployment_gaps_token
     ON robinhood_directional_transfer_deployment_gaps(token_address, range_id)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 160 Robinhood directional deployment gaps created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 160:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
