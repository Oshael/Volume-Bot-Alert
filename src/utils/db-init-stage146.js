/** Stage 146 - audited closure metadata for Robinhood infrastructure intervals. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_infrastructure_registry
     ADD COLUMN IF NOT EXISTS closed_source VARCHAR(64),
     ADD COLUMN IF NOT EXISTS closed_evidence_json JSONB,
     ADD COLUMN IF NOT EXISTS closed_verified_at TIMESTAMPTZ`,
  `DO $constraints$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'rh_infrastructure_registry_closure_payload_check'
          AND conrelid = 'robinhood_infrastructure_registry'::regclass
     ) THEN
       ALTER TABLE robinhood_infrastructure_registry
         ADD CONSTRAINT rh_infrastructure_registry_closure_payload_check CHECK (
           (closed_source IS NULL
             AND closed_evidence_json IS NULL
             AND closed_verified_at IS NULL)
           OR (closed_source IS NOT NULL
             AND closed_source ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
             AND closed_evidence_json IS NOT NULL
             AND jsonb_typeof(closed_evidence_json) = 'object'
             AND closed_evidence_json <> '{}'::jsonb
             AND closed_verified_at IS NOT NULL)
         );
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'rh_infrastructure_registry_open_closure_check'
          AND conrelid = 'robinhood_infrastructure_registry'::regclass
     ) THEN
       ALTER TABLE robinhood_infrastructure_registry
         ADD CONSTRAINT rh_infrastructure_registry_open_closure_check CHECK (
           valid_through_block IS NOT NULL
           OR (closed_source IS NULL
             AND closed_evidence_json IS NULL
             AND closed_verified_at IS NULL)
         );
     END IF;
   END
   $constraints$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 146 Robinhood infrastructure closure metadata created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 146:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
