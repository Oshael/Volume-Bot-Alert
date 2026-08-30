/** Stage 180 - durable hot queue for realtime Robinhood holder application. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_holder_hot_queue (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     first_pending_block BIGINT NOT NULL,
     last_pending_block BIGINT NOT NULL,
     first_enqueued_at TIMESTAMPTZ NOT NULL,
     last_enqueued_at TIMESTAMPTZ NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_hot_queue_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT rh_holder_hot_queue_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_hot_queue_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_holder_hot_queue_bounds_check CHECK (
       first_pending_block >= 0 AND last_pending_block >= first_pending_block
       AND last_enqueued_at >= first_enqueued_at
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_hot_queue_priority
     ON robinhood_holder_hot_queue(updated_at, last_pending_block DESC)`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_holder_hot()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     INSERT INTO robinhood_holder_hot_queue (
       chain, token_address, first_pending_block, last_pending_block,
       first_enqueued_at, last_enqueued_at
     )
     SELECT chain, token_address, MIN(block_number), MAX(block_number),
            MIN(captured_at), MAX(captured_at)
       FROM inserted_holder_transfers
      WHERE applied = FALSE
      GROUP BY chain, token_address
     ON CONFLICT (chain, token_address) DO UPDATE SET
       first_pending_block = LEAST(
         robinhood_holder_hot_queue.first_pending_block,
         EXCLUDED.first_pending_block
       ),
       last_pending_block = GREATEST(
         robinhood_holder_hot_queue.last_pending_block,
         EXCLUDED.last_pending_block
       ),
       first_enqueued_at = LEAST(
         robinhood_holder_hot_queue.first_enqueued_at,
         EXCLUDED.first_enqueued_at
       ),
       last_enqueued_at = GREATEST(
         robinhood_holder_hot_queue.last_enqueued_at,
         EXCLUDED.last_enqueued_at
       );
     PERFORM pg_notify('robinhood_holder_hot_queue', token_address)
       FROM (SELECT DISTINCT token_address FROM inserted_holder_transfers
              WHERE applied = FALSE) notified;
     RETURN NULL;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_holder_journal_hot_enqueue
     ON robinhood_holder_transfer_journal`,
  `CREATE TRIGGER rh_holder_journal_hot_enqueue
     AFTER INSERT ON robinhood_holder_transfer_journal
     REFERENCING NEW TABLE AS inserted_holder_transfers
     FOR EACH STATEMENT EXECUTE FUNCTION enqueue_robinhood_holder_hot()`,
  `INSERT INTO robinhood_holder_hot_queue (
     chain, token_address, first_pending_block, last_pending_block,
     first_enqueued_at, last_enqueued_at
   )
   SELECT state.chain, state.token_address, pending.first_block, pending.last_block,
          pending.first_at, pending.last_at
     FROM robinhood_holder_token_states state
     INNER JOIN LATERAL (
       SELECT MIN(block_number) AS first_block, MAX(block_number) AS last_block,
              MIN(captured_at) AS first_at, MAX(captured_at) AS last_at
         FROM robinhood_holder_transfer_journal journal
        WHERE journal.chain = state.chain
          AND journal.token_address = state.token_address AND journal.applied = FALSE
     ) pending ON pending.first_block IS NOT NULL
    WHERE state.chain = 'robinhood' AND state.ledger_status IN ('shadow', 'live')
   ON CONFLICT (chain, token_address) DO NOTHING`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 180 Robinhood holder hot queue created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 180:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
