/** Stage 116 - shadow Robinhood holder ledger persistence foundation. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_holder_balances (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     balance_raw NUMERIC(78,0) NOT NULL,
     last_block_number BIGINT NOT NULL,
     last_transaction_hash VARCHAR(66) NOT NULL,
     last_log_index INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_holder_balances_pkey
       PRIMARY KEY (chain, token_address, wallet_address),
     CONSTRAINT robinhood_holder_balances_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_holder_balances_token_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT robinhood_holder_balances_wallet_check
       CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'
         AND wallet_address <> '0x0000000000000000000000000000000000000000'),
     CONSTRAINT robinhood_holder_balances_positive_check CHECK (balance_raw > 0),
     CONSTRAINT robinhood_holder_balances_position_check
       CHECK (last_block_number >= 0 AND last_log_index >= 0),
     CONSTRAINT robinhood_holder_balances_tx_check
       CHECK (last_transaction_hash ~ '^0x[0-9a-f]{64}$')
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_balances_top
     ON robinhood_holder_balances(
       chain, token_address, balance_raw DESC, wallet_address ASC
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_holder_token_states (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     holder_count BIGINT NOT NULL DEFAULT 0,
     ledger_status VARCHAR(16) NOT NULL DEFAULT 'pending',
     deployment_block BIGINT,
     backfill_next_block BIGINT,
     live_through_block BIGINT,
     live_through_hash VARCHAR(66),
     version BIGINT NOT NULL DEFAULT 0,
     last_reconciled_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_holder_token_states_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT robinhood_holder_token_states_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_holder_token_states_token_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT robinhood_holder_token_states_count_check CHECK (holder_count >= 0),
     CONSTRAINT robinhood_holder_token_states_status_check CHECK (
       ledger_status IN ('pending', 'backfilling', 'shadow', 'live', 'drifted', 'resyncing')
     ),
     CONSTRAINT robinhood_holder_token_states_blocks_check CHECK (
       (deployment_block IS NULL OR deployment_block >= 0)
       AND (backfill_next_block IS NULL OR backfill_next_block >= 0)
       AND (live_through_block IS NULL OR live_through_block >= 0)
       AND version >= 0
     ),
     CONSTRAINT robinhood_holder_token_states_live_pair_check CHECK (
       (live_through_block IS NULL) = (live_through_hash IS NULL)
       AND (live_through_hash IS NULL OR live_through_hash ~ '^0x[0-9a-f]{64}$')
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_token_states_work
     ON robinhood_holder_token_states(
       ledger_status, backfill_next_block ASC NULLS FIRST, token_address ASC
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_holder_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(16) NOT NULL DEFAULT 'live',
     next_block BIGINT NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_holder_cursors_pkey PRIMARY KEY (chain, stream),
     CONSTRAINT robinhood_holder_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_holder_cursors_stream_check CHECK (stream = 'live'),
     CONSTRAINT robinhood_holder_cursors_blocks_check CHECK (
       next_block >= 0 AND (safe_head IS NULL OR safe_head >= 0)
       AND (checkpoint_block IS NULL OR checkpoint_block >= 0) AND version >= 0
     ),
     CONSTRAINT robinhood_holder_cursors_checkpoint_pair_check CHECK (
       (checkpoint_block IS NULL) = (checkpoint_hash IS NULL)
       AND (checkpoint_hash IS NULL OR checkpoint_hash ~ '^0x[0-9a-f]{64}$')
     )
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_holder_transfer_journal (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     log_index INTEGER NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     amount_raw NUMERIC(78,0) NOT NULL,
     from_balance_before NUMERIC(78,0),
     from_balance_after NUMERIC(78,0),
     to_balance_before NUMERIC(78,0),
     to_balance_after NUMERIC(78,0),
     holder_delta SMALLINT,
     applied BOOLEAN NOT NULL DEFAULT false,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     applied_at TIMESTAMPTZ,
     CONSTRAINT robinhood_holder_transfer_journal_pkey
       PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_holder_transfer_journal_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_holder_transfer_journal_position_check CHECK (
       block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
     ),
     CONSTRAINT robinhood_holder_transfer_journal_hash_check CHECK (
       block_hash ~ '^0x[0-9a-f]{64}$' AND transaction_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT robinhood_holder_transfer_journal_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT robinhood_holder_transfer_journal_amount_check CHECK (amount_raw >= 0),
     CONSTRAINT robinhood_holder_transfer_journal_balances_check CHECK (
       (from_balance_before IS NULL OR from_balance_before >= 0)
       AND (from_balance_after IS NULL OR from_balance_after >= 0)
       AND (to_balance_before IS NULL OR to_balance_before >= 0)
       AND (to_balance_after IS NULL OR to_balance_after >= 0)
     ),
     CONSTRAINT robinhood_holder_transfer_journal_delta_check
       CHECK (holder_delta IS NULL OR holder_delta BETWEEN -1 AND 1),
     CONSTRAINT robinhood_holder_transfer_journal_applied_check CHECK (
       (applied = false AND applied_at IS NULL AND holder_delta IS NULL
         AND from_balance_before IS NULL AND from_balance_after IS NULL
         AND to_balance_before IS NULL AND to_balance_after IS NULL)
       OR (applied = true AND applied_at IS NOT NULL AND holder_delta IS NOT NULL)
     ),
     CONSTRAINT robinhood_holder_transfer_journal_applied_balances_check CHECK (
       applied = false OR (
         ((from_wallet = '0x0000000000000000000000000000000000000000'
             AND from_balance_before IS NULL AND from_balance_after IS NULL)
           OR (from_wallet <> '0x0000000000000000000000000000000000000000'
             AND from_balance_before IS NOT NULL AND from_balance_after IS NOT NULL))
         AND ((to_wallet = '0x0000000000000000000000000000000000000000'
             AND to_balance_before IS NULL AND to_balance_after IS NULL)
           OR (to_wallet <> '0x0000000000000000000000000000000000000000'
             AND to_balance_before IS NOT NULL AND to_balance_after IS NOT NULL))
       )
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_journal_pending
     ON robinhood_holder_transfer_journal(
       block_number ASC, transaction_index ASC, log_index ASC
     ) WHERE applied = false`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_journal_rollback
     ON robinhood_holder_transfer_journal(block_number DESC, log_index DESC)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 116 Robinhood holder shadow ledger schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 116:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
