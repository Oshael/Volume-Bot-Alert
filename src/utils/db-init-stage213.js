'use strict';

/** Stage 213 - durable holder-count realtime publication outbox. */
const db = require('../models/db');
const { NOTIFY_CHANNEL, TABLE } = require('../models/robinhood-holder-realtime-outbox');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     ledger_version BIGINT NOT NULL,
     event_kind VARCHAR(16) NOT NULL,
     holder_count BIGINT,
     observed_at TIMESTAMPTZ NOT NULL,
     live_through_block BIGINT NOT NULL,
     live_through_hash VARCHAR(66) NOT NULL,
     latency JSONB NOT NULL DEFAULT '{}'::jsonb,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     published_at TIMESTAMPTZ,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_holder_realtime_outbox_source_key
       UNIQUE (chain, token_address, ledger_version, event_kind),
     CONSTRAINT robinhood_holder_realtime_outbox_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_holder_realtime_outbox_address_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT robinhood_holder_realtime_outbox_event_check
       CHECK (event_kind IN ('observed', 'finalized', 'invalidate')
         AND ((event_kind = 'invalidate' AND holder_count IS NULL)
           OR (event_kind <> 'invalidate' AND holder_count >= 0))),
     CONSTRAINT robinhood_holder_realtime_outbox_block_check
       CHECK (live_through_block >= 0 AND live_through_hash ~ '^0x[0-9a-f]{64}$'),
     CONSTRAINT robinhood_holder_realtime_outbox_status_check
       CHECK (status IN ('pending', 'leased', 'complete', 'blocked') AND attempt_count >= 0),
     CONSTRAINT robinhood_holder_realtime_outbox_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_realtime_outbox_claim
     ON ${TABLE}(next_attempt_at, id) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_realtime_outbox_lease
     ON ${TABLE}(lease_until) WHERE status = 'leased'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 213 Robinhood holder realtime outbox created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 213:', error.message);
  process.exitCode = 1;
});

module.exports = { NOTIFY_CHANNEL, STATEMENTS, TABLE, init };
