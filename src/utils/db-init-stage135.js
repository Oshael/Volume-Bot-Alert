/** Stage 135 - conservative Robinhood transfer-endpoint role evidence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_endpoint_roles (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     endpoint_address VARCHAR(42) NOT NULL,
     endpoint_role VARCHAR(16) NOT NULL,
     evidence_source VARCHAR(64) NOT NULL,
     evidence_block BIGINT NOT NULL,
     evidence_block_hash VARCHAR(66) NOT NULL,
     resolver_version VARCHAR(64) NOT NULL,
     observed_from_block BIGINT NOT NULL,
     observed_through_block BIGINT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_endpoint_roles_pkey PRIMARY KEY (chain, endpoint_address),
     CONSTRAINT rh_wallet_endpoint_roles_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_endpoint_roles_address_check CHECK (
       endpoint_address ~ '^0x[0-9a-f]{40}$'
       AND endpoint_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_wallet_endpoint_roles_role_check CHECK (
       endpoint_role IN ('wallet', 'contract')
     ),
     CONSTRAINT rh_wallet_endpoint_roles_evidence_check CHECK (
       evidence_source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND resolver_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND evidence_block >= 0
       AND evidence_block_hash ~ '^0x[0-9a-f]{64}$'
       AND observed_from_block >= 0
       AND observed_through_block >= observed_from_block
       AND evidence_block BETWEEN observed_from_block AND observed_through_block
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_endpoint_roles_role
     ON robinhood_wallet_endpoint_roles(chain, endpoint_role, endpoint_address)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 135 Robinhood wallet endpoint roles created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 135:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
