'use strict';

/** Stage 206 - durable Robinhood canonical recovery journal and event outbox. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_chain_recoveries (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     generation BIGINT NOT NULL,
     status VARCHAR(24) NOT NULL DEFAULT 'detected',
     plan JSONB NOT NULL,
     detected_at TIMESTAMPTZ NOT NULL,
     rewound_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_recoveries_pkey PRIMARY KEY (chain, generation),
     CONSTRAINT rh_chain_recoveries_identity_check CHECK (
       chain = 'robinhood' AND generation >= 0
       AND jsonb_typeof(plan) = 'object'
       AND plan ? 'generation'
       AND plan ->> 'generation' = generation::text
     ),
     CONSTRAINT rh_chain_recoveries_status_check CHECK (
       status IN (
         'detected', 'rewound', 'awaiting_domains',
         'recapturing', 'complete', 'blocked'
       )
     ),
     CONSTRAINT rh_chain_recoveries_completion_check CHECK (
       (status = 'complete') = (completed_at IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_recoveries_status
     ON robinhood_chain_recoveries(chain, status, generation)`,
  `CREATE TABLE IF NOT EXISTS robinhood_chain_recovery_outbox (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     generation BIGINT NOT NULL,
     event_kind VARCHAR(24) NOT NULL,
     event_key VARCHAR(64) NOT NULL DEFAULT '',
     payload JSONB NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     published_at TIMESTAMPTZ,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_recovery_outbox_pkey PRIMARY KEY (
       chain, generation, event_kind, event_key
     ),
     CONSTRAINT rh_chain_recovery_outbox_recovery_fkey FOREIGN KEY (chain, generation)
       REFERENCES robinhood_chain_recoveries(chain, generation) ON DELETE CASCADE,
     CONSTRAINT rh_chain_recovery_outbox_identity_check CHECK (
       chain = 'robinhood' AND generation >= 0
       AND attempt_count >= 0 AND jsonb_typeof(payload) = 'object'
     ),
     CONSTRAINT rh_chain_recovery_outbox_event_check CHECK (
       event_kind IN ('detected', 'rewound', 'domain_ready', 'recaptured', 'complete', 'blocked')
       AND (event_kind = 'domain_ready') = (event_key <> '')
     ),
     CONSTRAINT rh_chain_recovery_outbox_status_check CHECK (
       status IN ('pending', 'leased', 'complete', 'blocked')
     ),
     CONSTRAINT rh_chain_recovery_outbox_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_chain_recovery_outbox_completion_check CHECK (
       (status = 'complete') = (published_at IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_recovery_outbox_claim
     ON robinhood_chain_recovery_outbox(next_attempt_at, generation, event_kind)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_recovery_outbox_lease
     ON robinhood_chain_recovery_outbox(lease_until) WHERE status = 'leased'`,
  `INSERT INTO robinhood_chain_recoveries(
     chain, generation, status, plan, detected_at
   )
   SELECT chain, generation, 'detected', recovery_plan, recovery_detected_at
     FROM robinhood_chain_capture_cursor
    WHERE recovery_state = 'recovery_required'
   ON CONFLICT (chain, generation) DO NOTHING`,
  `INSERT INTO robinhood_chain_recovery_outbox(
     chain, generation, event_kind, payload
   )
   SELECT chain, generation, 'detected', jsonb_build_object(
     'type', 'chain:reorg:detected',
     'generation', generation::text,
     'detectedAt', recovery_detected_at,
     'plan', recovery_plan
   )
     FROM robinhood_chain_capture_cursor
    WHERE recovery_state = 'recovery_required'
   ON CONFLICT (chain, generation, event_kind, event_key) DO NOTHING`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 206 Robinhood recovery journal created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 206:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
