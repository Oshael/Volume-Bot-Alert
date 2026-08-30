/** Stage 178 - FRESH activation, seed campaign, coverage, and durable work queue. */
const db = require('../models/db');

const RULE_VERSION = 'rh_fresh_signed_v1';
const CLASSIFICATION_VERSION = 'rh_holder_v1';

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_fresh_wallet_activations (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     classification_version VARCHAR(32) NOT NULL DEFAULT '${CLASSIFICATION_VERSION}',
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     activation_at TIMESTAMPTZ NOT NULL,
     activation_block BIGINT NOT NULL,
     activation_block_hash VARCHAR(66) NOT NULL,
     seed_cutoff_at TIMESTAMPTZ NOT NULL,
     first_buy_source_through TIMESTAMPTZ NOT NULL,
     first_buy_source_next_block BIGINT NOT NULL,
     activated_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_fresh_wallet_activations_pkey PRIMARY KEY (chain, rule_version),
     CONSTRAINT rh_fresh_wallet_activations_contract_check CHECK (
       chain = 'robinhood' AND rule_version = '${RULE_VERSION}'
       AND classification_version = '${CLASSIFICATION_VERSION}'
       AND status IN ('planned', 'active', 'retired')
     ),
     CONSTRAINT rh_fresh_wallet_activations_boundary_check CHECK (
       activation_block >= 0
       AND activation_block_hash ~ '^0x[0-9a-f]{64}$'
       AND seed_cutoff_at = activation_at - INTERVAL '14 days'
       AND first_buy_source_through >= activation_at
       AND first_buy_source_next_block > activation_block
     ),
     CONSTRAINT rh_fresh_wallet_activations_lifecycle_check CHECK (
       (status = 'planned') = (activated_at IS NULL)
     )
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_fresh_wallet_seed_runs (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     expected_token_count BIGINT NOT NULL,
     expected_pair_count BIGINT NOT NULL,
     completed_pair_count BIGINT NOT NULL DEFAULT 0,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_fresh_wallet_seed_runs_activation_fkey
       FOREIGN KEY (chain, rule_version)
       REFERENCES robinhood_fresh_wallet_activations(chain, rule_version),
     CONSTRAINT rh_fresh_wallet_seed_runs_unique UNIQUE (chain, rule_version),
     CONSTRAINT rh_fresh_wallet_seed_runs_counts_check CHECK (
       expected_token_count >= 0 AND expected_pair_count >= 0
       AND completed_pair_count BETWEEN 0 AND expected_pair_count
     ),
     CONSTRAINT rh_fresh_wallet_seed_runs_lifecycle_check CHECK (
       status IN ('planned', 'running', 'paused', 'completed', 'failed')
       AND ((status = 'planned' AND started_at IS NULL AND finished_at IS NULL)
         OR (status IN ('running', 'paused') AND started_at IS NOT NULL
           AND finished_at IS NULL)
         OR (status IN ('completed', 'failed') AND started_at IS NOT NULL
           AND finished_at IS NOT NULL))
       AND (status <> 'completed' OR completed_pair_count = expected_pair_count)
     )
   )`,
  `CREATE OR REPLACE FUNCTION protect_robinhood_fresh_wallet_seed_run()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     IF ROW(OLD.chain, OLD.rule_version, OLD.expected_token_count,
            OLD.expected_pair_count)
        IS DISTINCT FROM
        ROW(NEW.chain, NEW.rule_version, NEW.expected_token_count,
            NEW.expected_pair_count) THEN
       RAISE EXCEPTION 'FRESH seed cohort is immutable';
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_fresh_wallet_seed_run_immutable
     ON robinhood_fresh_wallet_seed_runs`,
  `CREATE TRIGGER rh_fresh_wallet_seed_run_immutable
     BEFORE UPDATE ON robinhood_fresh_wallet_seed_runs
     FOR EACH ROW EXECUTE FUNCTION protect_robinhood_fresh_wallet_seed_run()`,
  `CREATE OR REPLACE FUNCTION protect_robinhood_fresh_wallet_activation()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     IF ROW(OLD.classification_version, OLD.activation_at, OLD.activation_block,
            OLD.activation_block_hash, OLD.seed_cutoff_at,
            OLD.first_buy_source_through, OLD.first_buy_source_next_block)
        IS DISTINCT FROM
        ROW(NEW.classification_version, NEW.activation_at, NEW.activation_block,
            NEW.activation_block_hash, NEW.seed_cutoff_at,
            NEW.first_buy_source_through, NEW.first_buy_source_next_block) THEN
       RAISE EXCEPTION 'FRESH activation boundary is immutable';
     END IF;
     IF (OLD.status = 'active' AND NEW.status = 'planned')
        OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
       RAISE EXCEPTION 'FRESH activation status cannot move backwards';
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_fresh_wallet_activation_immutable
     ON robinhood_fresh_wallet_activations`,
  `CREATE TRIGGER rh_fresh_wallet_activation_immutable
     BEFORE UPDATE ON robinhood_fresh_wallet_activations
     FOR EACH ROW EXECUTE FUNCTION protect_robinhood_fresh_wallet_activation()`,
  `CREATE TABLE IF NOT EXISTS robinhood_fresh_wallet_queue (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     source_kind VARCHAR(8) NOT NULL,
     seed_run_id BIGINT REFERENCES robinhood_fresh_wallet_seed_runs(id),
     requested_version BIGINT NOT NULL DEFAULT 1,
     completed_version BIGINT NOT NULL DEFAULT 0,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_fresh_wallet_queue_pkey PRIMARY KEY (
       chain, token_address, wallet_address, rule_version
     ),
     CONSTRAINT rh_fresh_wallet_queue_first_buy_fkey
       FOREIGN KEY (chain, token_address, wallet_address)
       REFERENCES robinhood_wallet_token_first_buys(chain, token_address, wallet_address)
       ON DELETE CASCADE,
     CONSTRAINT rh_fresh_wallet_queue_activation_fkey
       FOREIGN KEY (chain, rule_version)
       REFERENCES robinhood_fresh_wallet_activations(chain, rule_version),
     CONSTRAINT rh_fresh_wallet_queue_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$' AND wallet_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_fresh_wallet_queue_source_check CHECK (
       (source_kind = 'seed' AND seed_run_id IS NOT NULL)
       OR (source_kind = 'live' AND seed_run_id IS NULL)
     ),
     CONSTRAINT rh_fresh_wallet_queue_lifecycle_check CHECK (
       requested_version >= 1 AND completed_version BETWEEN 0 AND requested_version
       AND attempt_count >= 0 AND status IN ('pending', 'leased', 'complete')
       AND (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       AND (status = 'complete') = (completed_at IS NOT NULL)
       AND (status <> 'complete' OR completed_version = requested_version)
       AND (last_error_code IS NULL) = (last_error_message IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_fresh_wallet_queue_claim
     ON robinhood_fresh_wallet_queue(next_attempt_at, updated_at)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_fresh_wallet_queue_lease
     ON robinhood_fresh_wallet_queue(lease_until) WHERE status = 'leased'`,
  `CREATE TABLE IF NOT EXISTS robinhood_fresh_wallet_token_coverage (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     coverage_scope VARCHAR(16) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     status_reason VARCHAR(64) NOT NULL,
     seed_run_id BIGINT REFERENCES robinhood_fresh_wallet_seed_runs(id),
     required_pair_count BIGINT NOT NULL DEFAULT 0,
     completed_pair_count BIGINT NOT NULL DEFAULT 0,
     through_block_number BIGINT,
     through_block_hash VARCHAR(66),
     observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_fresh_wallet_token_coverage_pkey PRIMARY KEY (
       chain, token_address, rule_version
     ),
     CONSTRAINT rh_fresh_wallet_token_coverage_activation_fkey
       FOREIGN KEY (chain, rule_version)
       REFERENCES robinhood_fresh_wallet_activations(chain, rule_version),
     CONSTRAINT rh_fresh_wallet_token_coverage_contract_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND coverage_scope IN ('seed', 'live', 'partial')
       AND status IN ('pending', 'ready', 'unavailable', 'stale', 'reorged')
       AND status_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND required_pair_count >= 0
       AND completed_pair_count BETWEEN 0 AND required_pair_count
       AND ((coverage_scope = 'seed') = (seed_run_id IS NOT NULL))
       AND (status <> 'ready' OR (
         coverage_scope <> 'partial' AND completed_pair_count = required_pair_count
       ))
     ),
     CONSTRAINT rh_fresh_wallet_token_coverage_frontier_check CHECK (
       (through_block_number IS NULL) = (through_block_hash IS NULL)
       AND (through_block_number IS NULL OR through_block_number >= 0)
       AND (through_block_hash IS NULL OR through_block_hash ~ '^0x[0-9a-f]{64}$')
       AND ((status IN ('ready', 'stale', 'reorged')) =
         (through_block_number IS NOT NULL))
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_fresh_wallet_token_coverage_status
     ON robinhood_fresh_wallet_token_coverage(
       chain, rule_version, status, coverage_scope, token_address
     )`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_fresh_wallet_live()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   DECLARE queued_count INTEGER;
   BEGIN
     IF TG_OP = 'UPDATE' AND
        ROW(OLD.transaction_hash, OLD.block_number, OLD.block_hash, OLD.block_time)
        IS NOT DISTINCT FROM
        ROW(NEW.transaction_hash, NEW.block_number, NEW.block_hash, NEW.block_time) THEN
       RETURN NEW;
     END IF;
     DELETE FROM robinhood_fresh_wallet_queue queue
      USING robinhood_fresh_wallet_activations activation
      WHERE queue.chain = NEW.chain AND queue.token_address = NEW.token_address
        AND queue.wallet_address = NEW.wallet_address
        AND queue.rule_version = activation.rule_version
        AND queue.source_kind = 'live' AND activation.chain = NEW.chain
        AND NEW.block_number <= activation.activation_block;
     INSERT INTO robinhood_fresh_wallet_queue(
       chain, token_address, wallet_address, rule_version, source_kind
     )
     SELECT NEW.chain, NEW.token_address, NEW.wallet_address,
            activation.rule_version, 'live'
       FROM robinhood_fresh_wallet_activations activation
      WHERE activation.chain = NEW.chain AND activation.status = 'active'
        AND NEW.block_number > activation.activation_block
     ON CONFLICT (chain, token_address, wallet_address, rule_version) DO UPDATE SET
       requested_version = robinhood_fresh_wallet_queue.requested_version + 1,
       status = 'pending', lease_owner = NULL, lease_until = NULL,
       next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
       completed_at = NULL, updated_at = NOW()
     WHERE robinhood_fresh_wallet_queue.source_kind = 'live';
     GET DIAGNOSTICS queued_count = ROW_COUNT;
     IF queued_count > 0 THEN
       PERFORM pg_notify('robinhood_fresh_wallet_queue', NEW.token_address);
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_first_buy_fresh_wallet_live
     ON robinhood_wallet_token_first_buys`,
  `CREATE TRIGGER rh_first_buy_fresh_wallet_live
     AFTER INSERT OR UPDATE OF transaction_hash, block_number, block_hash, block_time
     ON robinhood_wallet_token_first_buys
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_fresh_wallet_live()`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 178 Robinhood FRESH activation and queue created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 178:', error.message);
  process.exitCode = 1;
});

module.exports = { CLASSIFICATION_VERSION, RULE_VERSION, STATEMENTS, init };
