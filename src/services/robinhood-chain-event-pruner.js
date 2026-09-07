'use strict';

const db = require('../models/db');
const {
  createRobinhoodRetentionSafetyAudit,
} = require('./robinhood-retention-safety-audit');

const CHAIN = 'robinhood';
const DEFAULT_BATCH_LIMIT = 1_000;
const DEFAULT_MAX_BATCHES = 1;
const REQUIRED_INDEXES = Object.freeze([
  'idx_rh_chain_domain_outbox_event_lookup',
  'idx_rh_canonical_head_candidates_event_lookup',
]);

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    batchLimit: boundedInteger(input.batchLimit, DEFAULT_BATCH_LIMIT, 1, 5_000, 'batchLimit'),
    maxBatches: boundedInteger(input.maxBatches, DEFAULT_MAX_BATCHES, 1, 100, 'maxBatches'),
    pauseMs: boundedInteger(input.pauseMs, 1_000, 100, 60_000, 'pauseMs'),
  });
}

async function assertCascadeIndexes(client) {
  const result = await client.query(
    `/* chain-event-prune:indexes */ SELECT COUNT(*)::int AS ready_indexes
       FROM pg_index
      WHERE indexrelid = ANY(ARRAY[to_regclass($1), to_regclass($2)])
        AND indisvalid AND indisready`,
    REQUIRED_INDEXES
  );
  if (Number(result.rows[0]?.ready_indexes) !== REQUIRED_INDEXES.length) {
    const error = new Error('Stage 201 cascade indexes are missing or invalid');
    error.code = 'chain_event_prune_indexes_unavailable';
    throw error;
  }
}

async function pruneBatch(database, cutoffBlock, batchLimit) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const lock = await client.query(
      `/* chain-event-prune:lock */ SELECT pg_try_advisory_xact_lock(
         hashtext('robinhood-chain-event-pruner')) AS locked`
    );
    if (lock.rows[0]?.locked !== true) {
      await client.query('COMMIT');
      return Object.freeze({ status: 'blocked', reason: 'concurrent_pruner', deletedEvents: 0 });
    }
    await assertCascadeIndexes(client);
    const deleted = await client.query(
      `/* chain-event-prune:delete */ WITH candidates AS MATERIALIZED (
         SELECT event.chain, event.block_hash, event.log_index
           FROM robinhood_chain_events event
          WHERE event.chain=$1 AND event.block_number < $2
          ORDER BY event.block_number, event.transaction_index, event.log_index
          LIMIT $3::int
          FOR UPDATE OF event SKIP LOCKED
       ), removed AS (
         DELETE FROM robinhood_chain_events event
          USING candidates
          WHERE event.chain=candidates.chain
            AND event.block_hash=candidates.block_hash
            AND event.log_index=candidates.log_index
        RETURNING event.block_number
       )
       SELECT COUNT(*)::int AS deleted_events,
              MIN(block_number) AS first_deleted_block,
              MAX(block_number) AS last_deleted_block
         FROM removed`,
      [CHAIN, cutoffBlock, batchLimit]
    );
    await client.query('COMMIT');
    const row = deleted.rows[0] || {};
    const deletedEvents = Number(row.deleted_events || 0);
    return Object.freeze({
      status: deletedEvents < batchLimit ? 'prefix_drained' : 'draining',
      deletedEvents,
      firstDeletedBlock: row.first_deleted_block == null ? null : String(row.first_deleted_block),
      lastDeletedBlock: row.last_deleted_block == null ? null : String(row.last_deleted_block),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runPilot(input = {}, deps = {}) {
  const options = normalizeOptions(input);
  const database = deps.database || db;
  const audit = deps.audit || createRobinhoodRetentionSafetyAudit({ database });
  const safety = await audit.inspect();
  if (safety.chain_events?.ready_for_pilot !== true) {
    return Object.freeze({
      status: 'blocked', reason: 'retention_safety_audit', batches: 0,
      totalDeleted: 0, blockers: safety.chain_events?.blockers || [],
    });
  }
  const cutoffBlock = String(safety.chain_events.candidate_cutoff_block || '');
  if (!/^[1-9][0-9]*$/.test(cutoffBlock)) {
    throw new Error('Retention safety audit returned an invalid chain event cutoff');
  }
  const progress = deps.progress || (() => {});
  const shouldStop = deps.shouldStop || (() => false);
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let batches = 0;
  let totalDeleted = 0;
  let stopReason = 'batch_limit';
  for (let index = 0; index < options.maxBatches; index += 1) {
    if (shouldStop()) { stopReason = 'signal'; break; }
    const result = await pruneBatch(database, cutoffBlock, options.batchLimit);
    batches += 1;
    totalDeleted += result.deletedEvents;
    progress({ phase: 'batch', batch: batches, cutoffBlock, ...result });
    if (result.status !== 'draining') { stopReason = result.status; break; }
    if (index + 1 < options.maxBatches) await pause(options.pauseMs);
  }
  return Object.freeze({
    status: 'finished', stopReason, cutoffBlock, batches, totalDeleted,
  });
}

module.exports = {
  DEFAULT_BATCH_LIMIT, DEFAULT_MAX_BATCHES, REQUIRED_INDEXES,
  assertCascadeIndexes, normalizeOptions, pruneBatch, runPilot,
};
