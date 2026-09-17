'use strict';

/** Stage 236 - narrow mutable state for the Robinhood trade lifecycle outbox. */
const db = require('../models/db');

const SOURCE_TABLE = 'robinhood_wallet_swap_realtime_outbox';
const STATE_TABLE = 'robinhood_wallet_swap_realtime_states';
const SYNC_FUNCTION = 'sync_robinhood_wallet_swap_realtime_state';
const SYNC_TRIGGER = 'trg_rh_wallet_swap_realtime_state_sync';
const STATE_COLUMNS = `
  chain, transaction_hash, log_index, block_hash, event_kind,
  block_number, transaction_index, status, lease_owner, lease_until,
  attempt_count, next_attempt_at, published_at, last_error,
  audit_status, audit_lease_owner, audit_lease_until, audit_attempt_count,
  audit_next_attempt_at, audited_at, audit_last_error, terminalized_at,
  created_at, updated_at`;
const STATE_VALUES = `
  NEW.chain, NEW.transaction_hash, NEW.log_index, NEW.block_hash, NEW.event_kind,
  NEW.block_number, NEW.transaction_index, NEW.status, NEW.lease_owner, NEW.lease_until,
  NEW.attempt_count, NEW.next_attempt_at, NEW.published_at, NEW.last_error,
  NEW.audit_status, NEW.audit_lease_owner, NEW.audit_lease_until, NEW.audit_attempt_count,
  NEW.audit_next_attempt_at, NEW.audited_at, NEW.audit_last_error, NEW.terminalized_at,
  NEW.created_at, NEW.updated_at`;

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     event_kind VARCHAR(16) NOT NULL,
     block_number BIGINT NOT NULL,
     transaction_index INTEGER NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     published_at TIMESTAMPTZ,
     last_error TEXT,
     audit_status VARCHAR(16) NOT NULL DEFAULT 'pending',
     audit_lease_owner VARCHAR(128),
     audit_lease_until TIMESTAMPTZ,
     audit_attempt_count INTEGER NOT NULL DEFAULT 0,
     audit_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     audited_at TIMESTAMPTZ,
     audit_last_error TEXT,
     terminalized_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_swap_realtime_states_pkey PRIMARY KEY (
       chain, transaction_hash, log_index, block_hash, event_kind
     ),
     CONSTRAINT rh_wallet_swap_realtime_states_source_fkey FOREIGN KEY (
       chain, transaction_hash, log_index, block_hash, event_kind
     ) REFERENCES ${SOURCE_TABLE} (
       chain, transaction_hash, log_index, block_hash, event_kind
     ) ON DELETE CASCADE,
     CONSTRAINT rh_wallet_swap_realtime_states_identity_check CHECK (
       chain='robinhood' AND transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND block_hash ~ '^0x[0-9a-f]{64}$' AND log_index >= 0
       AND block_number >= 0 AND transaction_index >= 0
       AND event_kind IN ('observed', 'finalized', 'invalidate')
     ),
     CONSTRAINT rh_wallet_swap_realtime_states_publication_check CHECK (
       status IN ('pending', 'leased', 'complete', 'blocked')
       AND attempt_count >= 0
       AND ((status='leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
       AND ((status='complete') = (published_at IS NOT NULL))
     ),
     CONSTRAINT rh_wallet_swap_realtime_states_audit_check CHECK (
       audit_status IN ('pending', 'leased', 'complete', 'blocked')
       AND audit_attempt_count >= 0
       AND ((audit_status='leased') =
         (audit_lease_owner IS NOT NULL AND audit_lease_until IS NOT NULL))
       AND ((audit_status='complete') = (audited_at IS NOT NULL))
     )
   )`,
  `CREATE OR REPLACE FUNCTION ${SYNC_FUNCTION}()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     INSERT INTO ${STATE_TABLE} AS state (${STATE_COLUMNS})
     VALUES (${STATE_VALUES})
     ON CONFLICT (chain, transaction_hash, log_index, block_hash, event_kind)
     DO UPDATE SET
       block_number=EXCLUDED.block_number,
       transaction_index=EXCLUDED.transaction_index,
       status=EXCLUDED.status,
       lease_owner=EXCLUDED.lease_owner,
       lease_until=EXCLUDED.lease_until,
       attempt_count=EXCLUDED.attempt_count,
       next_attempt_at=EXCLUDED.next_attempt_at,
       published_at=EXCLUDED.published_at,
       last_error=EXCLUDED.last_error,
       audit_status=EXCLUDED.audit_status,
       audit_lease_owner=EXCLUDED.audit_lease_owner,
       audit_lease_until=EXCLUDED.audit_lease_until,
       audit_attempt_count=EXCLUDED.audit_attempt_count,
       audit_next_attempt_at=EXCLUDED.audit_next_attempt_at,
       audited_at=EXCLUDED.audited_at,
       audit_last_error=EXCLUDED.audit_last_error,
       terminalized_at=EXCLUDED.terminalized_at,
       created_at=EXCLUDED.created_at,
       updated_at=EXCLUDED.updated_at;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS ${SYNC_TRIGGER} ON ${SOURCE_TABLE}`,
  `CREATE TRIGGER ${SYNC_TRIGGER}
   AFTER INSERT OR UPDATE OF
     status, lease_owner, lease_until, attempt_count, next_attempt_at,
     published_at, last_error, audit_status, audit_lease_owner,
     audit_lease_until, audit_attempt_count, audit_next_attempt_at,
     audited_at, audit_last_error, terminalized_at, updated_at
   ON ${SOURCE_TABLE} FOR EACH ROW EXECUTE FUNCTION ${SYNC_FUNCTION}()`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      for (const statement of STATEMENTS) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 236 Robinhood wallet-swap realtime state shadow created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 236:', error.message);
  process.exitCode = 1;
});

module.exports = {
  SOURCE_TABLE, STATE_TABLE, STATEMENTS, SYNC_FUNCTION, SYNC_TRIGGER, init,
};
