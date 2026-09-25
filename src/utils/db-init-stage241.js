'use strict';

/** Stage 241 - durable block anchors for wallet-classification frontiers. */
const db = require('../models/db');

const CAPTURE_ANCHOR_SQL = `CREATE OR REPLACE FUNCTION capture_robinhood_chain_block_anchor(
     requested_chain TEXT, requested_block BIGINT, expected_hash TEXT DEFAULT NULL
   ) RETURNS VARCHAR(66) LANGUAGE plpgsql AS $function$
   DECLARE canonical_hash VARCHAR(66); canonical_time TIMESTAMPTZ;
           stored_time TIMESTAMPTZ; anchor_count BIGINT;
   BEGIN
     SELECT block_hash, block_timestamp INTO canonical_hash, canonical_time
       FROM robinhood_chain_blocks
      WHERE chain = requested_chain AND block_number = requested_block AND canonical
      LIMIT 1;
     IF canonical_hash IS NULL THEN
       SELECT COUNT(*), MIN(block_hash), MIN(block_timestamp)
         INTO anchor_count, canonical_hash, canonical_time
         FROM robinhood_chain_block_anchors
        WHERE chain = requested_chain AND block_number = requested_block;
       IF anchor_count > 1 THEN
         RAISE EXCEPTION 'Robinhood block anchor ambiguous at %', requested_block;
       END IF;
       IF anchor_count = 0 THEN RETURN NULL; END IF;
     END IF;
     IF expected_hash IS NOT NULL AND canonical_hash IS DISTINCT FROM expected_hash THEN
       RAISE EXCEPTION 'Robinhood block anchor hash mismatch at %: expected %, canonical %',
         requested_block, expected_hash, canonical_hash;
     END IF;
     INSERT INTO robinhood_chain_block_anchors(
       chain, block_number, block_hash, block_timestamp
     ) VALUES (requested_chain, requested_block, canonical_hash, canonical_time)
     ON CONFLICT (chain, block_number, block_hash) DO NOTHING;
     SELECT block_timestamp INTO stored_time
       FROM robinhood_chain_block_anchors
      WHERE chain = requested_chain AND block_number = requested_block
        AND block_hash = canonical_hash;
     IF stored_time IS DISTINCT FROM canonical_time THEN
       RAISE EXCEPTION 'Robinhood block anchor timestamp mismatch at %', requested_block;
     END IF;
     RETURN canonical_hash;
   END
   $function$`;

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_chain_block_anchors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_timestamp TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_block_anchors_pkey PRIMARY KEY (
       chain, block_number, block_hash
     ),
     CONSTRAINT rh_chain_block_anchors_values_check CHECK (
       chain = 'robinhood' AND block_number >= 0
       AND block_hash ~ '^0x[0-9a-f]{64}$'
     )
   )`,
  `ALTER TABLE robinhood_bundle_redistribution_activations
     ADD COLUMN IF NOT EXISTS observation_from_hash VARCHAR(66)`,
  `ALTER TABLE robinhood_bundle_redistribution_activations
     ADD COLUMN IF NOT EXISTS observation_from_time TIMESTAMPTZ`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD COLUMN IF NOT EXISTS observation_from_hash VARCHAR(66)`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD COLUMN IF NOT EXISTS observation_from_time TIMESTAMPTZ`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD COLUMN IF NOT EXISTS source_through_block BIGINT`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD COLUMN IF NOT EXISTS source_through_hash VARCHAR(66)`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD COLUMN IF NOT EXISTS source_through_time TIMESTAMPTZ`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD COLUMN IF NOT EXISTS source_requested_version BIGINT`,
  `ALTER TABLE robinhood_bundle_redistribution_activations
     DROP CONSTRAINT IF EXISTS rh_bundle_redistribution_activation_anchor_check`,
  `ALTER TABLE robinhood_bundle_redistribution_activations
     ADD CONSTRAINT rh_bundle_redistribution_activation_anchor_check CHECK (
       (observation_from_hash IS NULL) = (observation_from_time IS NULL)
       AND (observation_from_hash IS NULL
         OR observation_from_hash ~ '^0x[0-9a-f]{64}$')
     )`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     DROP CONSTRAINT IF EXISTS rh_bundle_redistribution_queue_anchor_check`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD CONSTRAINT rh_bundle_redistribution_queue_anchor_check CHECK (
       (observation_from_hash IS NULL) = (observation_from_time IS NULL)
       AND (observation_from_hash IS NULL
         OR observation_from_hash ~ '^0x[0-9a-f]{64}$')
       AND ((source_through_block IS NULL)::integer
         + (source_through_hash IS NULL)::integer
         + (source_through_time IS NULL)::integer
         + (source_requested_version IS NULL)::integer) IN (0, 4)
       AND (source_through_block IS NULL OR source_through_block >= observation_from_block)
       AND (source_through_hash IS NULL
         OR source_through_hash ~ '^0x[0-9a-f]{64}$')
       AND (source_requested_version IS NULL
         OR source_requested_version <= requested_version)
     )`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     DROP CONSTRAINT IF EXISTS rh_bundle_redistribution_queue_observation_anchor_fkey`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD CONSTRAINT rh_bundle_redistribution_queue_observation_anchor_fkey FOREIGN KEY (
       chain, observation_from_block, observation_from_hash
     ) REFERENCES robinhood_chain_block_anchors(chain, block_number, block_hash)`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     DROP CONSTRAINT IF EXISTS rh_bundle_redistribution_queue_source_anchor_fkey`,
  `ALTER TABLE robinhood_bundle_redistribution_queue
     ADD CONSTRAINT rh_bundle_redistribution_queue_source_anchor_fkey FOREIGN KEY (
       chain, source_through_block, source_through_hash
     ) REFERENCES robinhood_chain_block_anchors(chain, block_number, block_hash)`,
  CAPTURE_ANCHOR_SQL,
  `CREATE OR REPLACE FUNCTION hydrate_robinhood_redistribution_activation_anchor()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   DECLARE captured_hash VARCHAR(66); captured_time TIMESTAMPTZ;
   BEGIN
     IF NEW.observation_from_hash IS NULL AND NEW.status IN ('active', 'retired') THEN
       captured_hash := capture_robinhood_chain_block_anchor(
         NEW.chain, NEW.activation_block + 1, NULL
       );
       IF captured_hash IS NOT NULL THEN
         SELECT block_timestamp INTO captured_time
           FROM robinhood_chain_block_anchors
          WHERE chain = NEW.chain AND block_number = NEW.activation_block + 1
            AND block_hash = captured_hash;
         NEW.observation_from_hash := captured_hash;
         NEW.observation_from_time := captured_time;
       END IF;
     END IF;
     IF NEW.activation_checkpoint_block IS NOT NULL THEN
       PERFORM capture_robinhood_chain_block_anchor(
         NEW.chain, NEW.activation_checkpoint_block, NEW.activation_checkpoint_hash
       );
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS trg_rh_bundle_redistribution_activation_anchor
     ON robinhood_bundle_redistribution_activations`,
  `CREATE TRIGGER trg_rh_bundle_redistribution_activation_anchor
     BEFORE INSERT OR UPDATE OF status, activation_checkpoint_block,
       activation_checkpoint_hash, observation_from_hash
     ON robinhood_bundle_redistribution_activations
     FOR EACH ROW EXECUTE FUNCTION hydrate_robinhood_redistribution_activation_anchor()`,
  `CREATE OR REPLACE FUNCTION hydrate_robinhood_redistribution_queue_anchors()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   DECLARE captured_hash VARCHAR(66); holder_block BIGINT; holder_hash VARCHAR(66);
   BEGIN
     IF TG_OP = 'UPDATE' AND NEW.requested_version IS DISTINCT FROM OLD.requested_version THEN
       NEW.source_through_block := NULL;
       NEW.source_through_hash := NULL;
       NEW.source_through_time := NULL;
       NEW.source_requested_version := NULL;
     END IF;
     IF NEW.observation_from_hash IS NULL THEN
       captured_hash := capture_robinhood_chain_block_anchor(
         NEW.chain, NEW.observation_from_block, NULL
       );
       IF captured_hash IS NOT NULL THEN
         NEW.observation_from_hash := captured_hash;
         SELECT block_timestamp INTO NEW.observation_from_time
           FROM robinhood_chain_block_anchors
          WHERE chain = NEW.chain AND block_number = NEW.observation_from_block
            AND block_hash = captured_hash;
       END IF;
     END IF;
     SELECT live_through_block, live_through_hash INTO holder_block, holder_hash
       FROM robinhood_holder_token_states
      WHERE chain = NEW.chain AND token_address = NEW.token_address;
     IF holder_block IS NOT NULL THEN
       PERFORM capture_robinhood_chain_block_anchor(NEW.chain, holder_block, holder_hash);
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS trg_rh_bundle_redistribution_queue_anchors
     ON robinhood_bundle_redistribution_queue`,
  `CREATE TRIGGER trg_rh_bundle_redistribution_queue_anchors
     BEFORE INSERT OR UPDATE OF observation_from_block, requested_version
     ON robinhood_bundle_redistribution_queue
     FOR EACH ROW EXECUTE FUNCTION hydrate_robinhood_redistribution_queue_anchors()`,
  `CREATE OR REPLACE FUNCTION capture_robinhood_holder_frontier_anchor()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     IF NEW.live_through_block IS NULL THEN RETURN NEW; END IF;
     IF TG_OP = 'UPDATE'
        AND ROW(NEW.live_through_block, NEW.live_through_hash) IS NOT DISTINCT FROM
            ROW(OLD.live_through_block, OLD.live_through_hash) THEN
       RETURN NEW;
     END IF;
     IF EXISTS (
          SELECT 1 FROM robinhood_bundle_redistribution_queue queue
           WHERE queue.chain = NEW.chain AND queue.token_address = NEW.token_address
        ) THEN
       PERFORM capture_robinhood_chain_block_anchor(
         NEW.chain, NEW.live_through_block, NEW.live_through_hash
       );
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS trg_rh_holder_redistribution_frontier_anchor
     ON robinhood_holder_token_states`,
  `CREATE TRIGGER trg_rh_holder_redistribution_frontier_anchor
     AFTER INSERT OR UPDATE OF live_through_block, live_through_hash
     ON robinhood_holder_token_states
     FOR EACH ROW EXECUTE FUNCTION capture_robinhood_holder_frontier_anchor()`,
  `UPDATE robinhood_bundle_redistribution_activations
      SET observation_from_hash = observation_from_hash
    WHERE status IN ('active', 'retired') AND observation_from_hash IS NULL`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 241 wallet-classification anchors created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 241:', error.message);
  process.exitCode = 1;
});

module.exports = { CAPTURE_ANCHOR_SQL, STATEMENTS, init };
