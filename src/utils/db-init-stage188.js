'use strict';

/** Stage 188 - live-only BUNDLED redistribution activation and durable queue. */
const db = require('../models/db');

const RULE_VERSION = 'rh_possible_bundle_redistribution_v1';
const EVIDENCE_VERSION = 'rh_token_redistribution_v1';
const PROJECTION_VERSION = 'rh_transfer_v1';
const NOTIFY_CHANNEL = 'robinhood_bundle_redistribution_queue';

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_redistribution_activations (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     evidence_version VARCHAR(64) NOT NULL DEFAULT '${EVIDENCE_VERSION}',
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     activation_at TIMESTAMPTZ NOT NULL,
     activation_block BIGINT NOT NULL,
     activation_block_hash VARCHAR(66),
     activated_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_redistribution_activations_pkey PRIMARY KEY (
       chain, rule_version
     ),
     CONSTRAINT rh_bundle_redistribution_activations_contract_check CHECK (
       chain = 'robinhood' AND rule_version = '${RULE_VERSION}'
       AND evidence_version = '${EVIDENCE_VERSION}'
       AND status IN ('planned', 'active', 'retired')
       AND activation_block >= 0
       AND (activation_block_hash IS NULL
         OR activation_block_hash ~ '^0x[0-9a-f]{64}$')
     ),
     CONSTRAINT rh_bundle_redistribution_activations_lifecycle_check CHECK (
       (status = 'planned' AND activation_block_hash IS NULL AND activated_at IS NULL)
       OR (status IN ('active', 'retired')
         AND activation_block_hash IS NOT NULL AND activated_at IS NOT NULL)
     )
   )`,
  `CREATE OR REPLACE FUNCTION protect_robinhood_bundle_redistribution_activation()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     IF TG_OP = 'INSERT' THEN
       IF NEW.status <> 'planned' OR NEW.activation_block_hash IS NOT NULL
          OR NEW.activated_at IS NOT NULL THEN
         RAISE EXCEPTION 'BUNDLED redistribution activation must start planned';
       END IF;
       RETURN NEW;
     END IF;
     IF ROW(OLD.chain, OLD.rule_version, OLD.evidence_version, OLD.activation_at,
            OLD.activation_block)
        IS DISTINCT FROM
        ROW(NEW.chain, NEW.rule_version, NEW.evidence_version, NEW.activation_at,
            NEW.activation_block) THEN
       RAISE EXCEPTION 'BUNDLED redistribution activation boundary is immutable';
     END IF;
     IF (OLD.status = 'active' AND NEW.status = 'planned')
        OR (OLD.status = 'retired' AND NEW.status <> 'retired')
        OR (OLD.activated_at IS NOT NULL
          AND OLD.activated_at IS DISTINCT FROM NEW.activated_at)
        OR (OLD.activation_block_hash IS NOT NULL
          AND OLD.activation_block_hash IS DISTINCT FROM NEW.activation_block_hash) THEN
       RAISE EXCEPTION 'BUNDLED redistribution activation cannot move backwards';
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_bundle_redistribution_activation_immutable
     ON robinhood_bundle_redistribution_activations`,
  `CREATE TRIGGER rh_bundle_redistribution_activation_immutable
     BEFORE INSERT OR UPDATE ON robinhood_bundle_redistribution_activations
     FOR EACH ROW EXECUTE FUNCTION protect_robinhood_bundle_redistribution_activation()`,
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_redistribution_queue (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     evidence_version VARCHAR(64) NOT NULL DEFAULT '${EVIDENCE_VERSION}',
     observation_from_block BIGINT NOT NULL,
     event_through_block BIGINT NOT NULL,
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
     CONSTRAINT rh_bundle_redistribution_queue_pkey PRIMARY KEY (
       chain, token_address, rule_version
     ),
     CONSTRAINT rh_bundle_redistribution_queue_activation_fkey FOREIGN KEY (
       chain, rule_version
     ) REFERENCES robinhood_bundle_redistribution_activations(chain, rule_version),
     CONSTRAINT rh_bundle_redistribution_queue_contract_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND rule_version = '${RULE_VERSION}'
       AND evidence_version = '${EVIDENCE_VERSION}'
       AND observation_from_block >= 1
       AND event_through_block >= observation_from_block
       AND requested_version >= 1
       AND completed_version BETWEEN 0 AND requested_version
       AND attempt_count >= 0
     ),
     CONSTRAINT rh_bundle_redistribution_queue_lifecycle_check CHECK (
       status IN ('pending', 'leased', 'complete')
       AND (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       AND (status = 'complete') = (completed_at IS NOT NULL)
       AND (status <> 'complete' OR completed_version = requested_version)
       AND (last_error_code IS NULL) = (last_error_message IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_redistribution_queue_claim
     ON robinhood_bundle_redistribution_queue(next_attempt_at, updated_at)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_redistribution_queue_lease
     ON robinhood_bundle_redistribution_queue(lease_until)
     WHERE status = 'leased'`,
  `CREATE OR REPLACE FUNCTION request_robinhood_bundle_redistribution(
     requested_chain TEXT, requested_token TEXT, requested_block BIGINT,
     allow_insert BOOLEAN
   ) RETURNS INTEGER LANGUAGE plpgsql AS $function$
   DECLARE queued_count INTEGER;
   BEGIN
     IF allow_insert THEN
       INSERT INTO robinhood_bundle_redistribution_queue(
         chain, token_address, rule_version, evidence_version,
         observation_from_block, event_through_block
       ) SELECT activation.chain, requested_token, activation.rule_version,
                activation.evidence_version, activation.activation_block + 1,
                requested_block
           FROM robinhood_bundle_redistribution_activations activation
          WHERE activation.chain = requested_chain
            AND activation.status IN ('planned', 'active')
            AND requested_block > activation.activation_block
       ON CONFLICT (chain, token_address, rule_version) DO UPDATE SET
         event_through_block = GREATEST(
           robinhood_bundle_redistribution_queue.event_through_block,
           EXCLUDED.event_through_block
         ),
         requested_version = robinhood_bundle_redistribution_queue.requested_version + 1,
         status = 'pending', lease_owner = NULL, lease_until = NULL,
         next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
         completed_at = NULL, updated_at = NOW()
       WHERE robinhood_bundle_redistribution_queue.observation_from_block
         = EXCLUDED.observation_from_block;
     ELSE
       UPDATE robinhood_bundle_redistribution_queue queue SET
         event_through_block = GREATEST(queue.event_through_block, requested_block),
         requested_version = queue.requested_version + 1,
         status = 'pending', lease_owner = NULL, lease_until = NULL,
         next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
         completed_at = NULL, updated_at = NOW()
       FROM robinhood_bundle_redistribution_activations activation
       WHERE queue.chain = requested_chain AND queue.token_address = requested_token
         AND activation.chain = queue.chain AND activation.rule_version = queue.rule_version
         AND activation.status IN ('planned', 'active')
         AND requested_block > activation.activation_block;
     END IF;
     GET DIAGNOSTICS queued_count = ROW_COUNT;
     RETURN queued_count;
   END
   $function$`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_bundle_redistribution_transfer()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   DECLARE event_chain TEXT; event_token TEXT; event_version TEXT;
           event_block BIGINT; queued_count INTEGER;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       event_chain := OLD.chain; event_token := OLD.token_address;
       event_version := OLD.classification_version;
       event_block := OLD.first_wallet_transfer_block;
     ELSE
       event_chain := NEW.chain; event_token := NEW.token_address;
       event_version := NEW.classification_version;
       event_block := GREATEST(NEW.first_wallet_transfer_block,
         CASE WHEN TG_OP = 'UPDATE' THEN OLD.first_wallet_transfer_block END);
     END IF;
     IF event_version = '${PROJECTION_VERSION}' AND event_block IS NOT NULL THEN
       queued_count := request_robinhood_bundle_redistribution(
         event_chain, event_token, event_block, TRUE
       );
       IF queued_count > 0 THEN PERFORM pg_notify('${NOTIFY_CHANNEL}', event_token); END IF;
     END IF;
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_bundle_redistribution_transfer_insert_delete
     ON robinhood_wallet_transfer_edges`,
  `CREATE TRIGGER rh_bundle_redistribution_transfer_insert_delete
     AFTER INSERT OR DELETE ON robinhood_wallet_transfer_edges
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_bundle_redistribution_transfer()`,
  `DROP TRIGGER IF EXISTS rh_bundle_redistribution_transfer_update
     ON robinhood_wallet_transfer_edges`,
  `CREATE TRIGGER rh_bundle_redistribution_transfer_update
     AFTER UPDATE OF first_wallet_transfer_block, first_wallet_transfer_log_index,
       first_wallet_transfer_transaction_hash, first_wallet_transfer_amount_raw
     ON robinhood_wallet_transfer_edges
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_bundle_redistribution_transfer()`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_bundle_redistribution_sell()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   DECLARE event_chain TEXT; event_token TEXT; event_side TEXT;
           event_block BIGINT; queued_count INTEGER;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       event_chain := OLD.chain; event_token := OLD.token_address;
       event_side := OLD.side; event_block := OLD.block_number;
     ELSE
       event_chain := NEW.chain; event_token := NEW.token_address;
       event_side := NEW.side; event_block := NEW.block_number;
     END IF;
     IF event_side = 'sell' THEN
       queued_count := request_robinhood_bundle_redistribution(
         event_chain, event_token, event_block, FALSE
       );
       IF queued_count > 0 THEN PERFORM pg_notify('${NOTIFY_CHANNEL}', event_token); END IF;
     END IF;
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_bundle_redistribution_sell_insert_delete
     ON robinhood_wallet_swaps`,
  `CREATE TRIGGER rh_bundle_redistribution_sell_insert_delete
     AFTER INSERT OR DELETE ON robinhood_wallet_swaps
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_bundle_redistribution_sell()`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 188 Robinhood BUNDLED redistribution live queue created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 188:', error.message);
  process.exitCode = 1;
});

module.exports = {
  EVIDENCE_VERSION, NOTIFY_CHANNEL, PROJECTION_VERSION, RULE_VERSION, STATEMENTS, init,
};
