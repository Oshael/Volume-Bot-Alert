/** Stage 145 - audited Robinhood infrastructure address registry. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_infrastructure_registry (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     address VARCHAR(42) NOT NULL,
     kind VARCHAR(16) NOT NULL,
     label VARCHAR(120) NOT NULL,
     source VARCHAR(64) NOT NULL,
     evidence_json JSONB NOT NULL,
     valid_from_block BIGINT NOT NULL,
     valid_through_block BIGINT,
     verified_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_infrastructure_registry_pkey PRIMARY KEY (
       chain, address, kind, valid_from_block
     ),
     CONSTRAINT rh_infrastructure_registry_chain_check CHECK (
       chain = 'robinhood'
     ),
     CONSTRAINT rh_infrastructure_registry_address_check CHECK (
       address ~ '^0x[0-9a-f]{40}$'
       AND (kind = 'burn'
         OR address <> '0x0000000000000000000000000000000000000000')
     ),
     CONSTRAINT rh_infrastructure_registry_kind_check CHECK (
       kind IN ('cex', 'router', 'bridge', 'locker', 'burn')
     ),
     CONSTRAINT rh_infrastructure_registry_text_check CHECK (
       label = BTRIM(label) AND label <> ''
       AND source ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
     ),
     CONSTRAINT rh_infrastructure_registry_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     ),
     CONSTRAINT rh_infrastructure_registry_validity_check CHECK (
       valid_from_block >= 0
       AND (valid_through_block IS NULL OR valid_through_block >= valid_from_block)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_infrastructure_registry_open
     ON robinhood_infrastructure_registry(chain, address, kind)
     WHERE valid_through_block IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_rh_infrastructure_registry_kind_lookup
     ON robinhood_infrastructure_registry(
       chain, kind, address, valid_from_block DESC, valid_through_block
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 145 Robinhood infrastructure registry created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 145:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
