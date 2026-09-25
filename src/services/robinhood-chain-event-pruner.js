'use strict';

const db = require('../models/db');
const {
  createRobinhoodRetentionSafetyAudit,
} = require('./robinhood-retention-safety-audit');

const CHAIN = 'robinhood';
const DEFAULT_BATCH_LIMIT = 1_000;
const DEFAULT_MAX_BATCHES = 1;
const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const PARTITION_WIDTH = 250_000n;
const REQUIRED_INDEXES = Object.freeze([
  'idx_rh_chain_domain_outbox_event_lookup',
  'idx_rh_canonical_head_candidates_event_lookup',
]);
const REQUIRED_STORAGE_INDEXES = Object.freeze([
  'idx_rh_chain_blocks_retention',
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
    retentionMs: boundedInteger(
      input.retentionMs,
      DEFAULT_RETENTION_MS,
      DEFAULT_RETENTION_MS,
      30 * 24 * 60 * 60 * 1000,
      'retentionMs'
    ),
    untilDrained: input.untilDrained === true,
    pruneCanonicalStorage: input.pruneCanonicalStorage === true,
    partitionDropEnabled: input.partitionDropEnabled === true,
    partitionPreview: input.partitionPreview === true,
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

async function assertCanonicalStorageIndexes(client) {
  const result = await client.query(
    `/* chain-event-prune:storage-indexes */ SELECT COUNT(*)::int AS ready_indexes
       FROM pg_index
      WHERE indexrelid = to_regclass($1)
        AND indisvalid AND indisready`,
    REQUIRED_STORAGE_INDEXES
  );
  if (Number(result.rows[0]?.ready_indexes) !== REQUIRED_STORAGE_INDEXES.length) {
    const error = new Error('Stage 240 canonical raw retention indexes are missing or invalid');
    error.code = 'canonical_raw_prune_indexes_unavailable';
    throw error;
  }
}

async function legacyEventStorage(client) {
  const result = await client.query(`/* chain-event-prune:relation-kind */
    SELECT relkind FROM pg_class
    WHERE oid=to_regclass('robinhood_chain_events')`);
  const kind = result.rows[0]?.relkind;
  if (kind === 'r') return true;
  if (kind === 'p') return false;
  throw new Error('Robinhood event relation is unavailable');
}

function partitionRange(row) {
  const match = /^FOR VALUES FROM \('([0-9]+)'\) TO \('([0-9]+)'\)$/.exec(row.bound || '');
  if (!match) throw new Error(`unexpected chain event partition bound: ${row.bound}`);
  const start = BigInt(match[1]);
  const end = BigInt(match[2]);
  if (start % PARTITION_WIDTH !== 0n || end !== start + PARTITION_WIDTH
      || row.relname !== `robinhood_chain_events_shadow_b${start}`
      || !/^[a-z_][a-z0-9_]*$/.test(row.schema)) {
    throw new Error(`unexpected chain event partition: ${row.relname}`);
  }
  return { ...row, start, end, name: `${row.schema}.${row.relname}` };
}

async function partitionReferences(client, start, end) {
  const result = await client.query(`/* chain-event-prune:references */ SELECT
    EXISTS (SELECT 1 FROM robinhood_chain_domain_outbox
      WHERE chain=$1 AND block_number >= $2::bigint AND block_number < $3::bigint)
      AS outbox,
    EXISTS (SELECT 1 FROM robinhood_canonical_head_candidates
      WHERE chain=$1 AND block_number >= $2::bigint AND block_number < $3::bigint)
      AS candidates`, [CHAIN, String(start), String(end)]);
  return result.rows[0];
}

async function prunePartition(client, cutoffBlock, retentionMs, preview) {
  const catalog = await client.query(`/* chain-event-prune:partitions */ SELECT
      child.relname, namespace.nspname AS schema,
      pg_get_expr(child.relpartbound, child.oid) AS bound,
      pg_total_relation_size(child.oid)::text AS bytes,
      inheritance.inhdetachpending AS detach_pending
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid=inheritance.inhrelid
    JOIN pg_namespace namespace ON namespace.oid=child.relnamespace
    WHERE inheritance.inhparent=to_regclass('robinhood_chain_events')`);
  if (catalog.rows.some((row) => row.detach_pending)) {
    return { status: 'blocked', reason: 'detach_pending', partitioned: true,
      deletedEvents: 0 };
  }
  const partitions = catalog.rows.map(partitionRange)
    .sort((left, right) => left.start < right.start ? -1 : 1);
  const oldest = partitions[0];
  if (!oldest || oldest.end > BigInt(cutoffBlock)) {
    return { status: 'prefix_drained', partitioned: true, deletedEvents: 0 };
  }
  const state = await client.query(`/* chain-event-prune:partition-state */ SELECT
      cursor.finalized_head::text, cursor.recovery_state,
      EXISTS (SELECT 1 FROM robinhood_chain_blocks block
        WHERE block.chain=$1 AND block.block_number >= $2::bigint
          AND block.block_number < $3::bigint
          AND block.block_timestamp >= NOW() - ($4::bigint * INTERVAL '1 millisecond'))
        AS within_retention
    FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain=$1`,
  [CHAIN, String(oldest.start), String(oldest.end), retentionMs]);
  const row = state.rows[0];
  if (!row || row.recovery_state !== 'running' || row.finalized_head == null
      || BigInt(row.finalized_head) < oldest.end - 1n || row.within_retention !== false) {
    return { status: 'blocked', reason: 'partition_not_finalized_or_expired',
      partitioned: true, deletedEvents: 0 };
  }
  const references = await partitionReferences(client, oldest.start, oldest.end);
  if (references?.outbox !== false || references?.candidates !== false) {
    return { status: 'blocked', reason: 'partition_referenced', partitioned: true,
      deletedEvents: 0 };
  }
  if (preview) return { status: 'eligible', partitioned: true, deletedEvents: 0,
    candidatePartition: oldest.name, candidateBytes: oldest.bytes };
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query('LOCK TABLE robinhood_chain_events IN ACCESS EXCLUSIVE MODE');
  const lockedReferences = await partitionReferences(client, oldest.start, oldest.end);
  if (lockedReferences?.outbox !== false || lockedReferences?.candidates !== false) {
    return { status: 'blocked', reason: 'partition_referenced', partitioned: true,
      deletedEvents: 0 };
  }
  await client.query(`ALTER TABLE robinhood_chain_events DETACH PARTITION ${oldest.name}`);
  await client.query(`DROP TABLE ${oldest.name} RESTRICT`);
  return { status: 'draining', partitioned: true, deletedEvents: 0,
    droppedPartitions: 1, droppedPartition: oldest.name, freedBytes: oldest.bytes };
}

async function partitionModeResult(client, legacy, cutoffBlock, retentionMs,
  partitionDropEnabled, partitionPreview) {
  if (!legacy && (partitionDropEnabled || partitionPreview)) {
    return prunePartition(client, cutoffBlock, retentionMs, partitionPreview);
  }
  return { status: 'blocked', reason: legacy
    ? 'requires_partitioned_events' : 'partition_drop_disabled',
  partitioned: !legacy, deletedEvents: 0 };
}

async function resolveRetentionCutoff(database, input) {
  const client = await database.getClient();
  try {
    const result = await client.query(
      `/* chain-event-prune:retention-cutoff */ WITH RECURSIVE search(lo, hi) AS (
         SELECT $2::bigint, $3::bigint
         UNION ALL
         SELECT CASE WHEN block.block_timestamp
                            < NOW() - ($4::bigint * INTERVAL '1 millisecond')
                       THEN search.lo + ((search.hi - search.lo) / 2) + 1
                       ELSE search.lo END,
                CASE WHEN block.block_timestamp
                            < NOW() - ($4::bigint * INTERVAL '1 millisecond')
                       THEN search.hi
                       ELSE search.lo + ((search.hi - search.lo) / 2) END
           FROM search
           JOIN robinhood_chain_blocks block
             ON block.chain=$1 AND block.canonical
            AND block.block_number=search.lo + ((search.hi - search.lo) / 2)
          WHERE search.lo < search.hi
       )
       SELECT lo::text AS cutoff_block
         FROM search
        ORDER BY (hi - lo), lo DESC
        LIMIT 1`,
      [CHAIN, input.journalStartBlock, input.safetyCutoffBlock, input.retentionMs]
    );
    const cutoffBlock = String(result.rows[0]?.cutoff_block || '');
    if (!/^[0-9]+$/.test(cutoffBlock)) {
      throw new Error('Could not resolve the chain event retention cutoff');
    }
    return cutoffBlock;
  } finally {
    client.release();
  }
}

async function pruneBatch(database, cutoffBlock, batchLimit,
  retentionMs = DEFAULT_RETENTION_MS, partitionDropEnabled = false, partitionPreview = false) {
  const protectedRetentionMs = boundedInteger(
    retentionMs, DEFAULT_RETENTION_MS, DEFAULT_RETENTION_MS,
    30 * 24 * 60 * 60 * 1000, 'retentionMs'
  );
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
    const legacy = await legacyEventStorage(client);
    if (!legacy || partitionPreview || partitionDropEnabled) {
      const result = await partitionModeResult(client, legacy, cutoffBlock,
        protectedRetentionMs, partitionDropEnabled, partitionPreview);
      await client.query('COMMIT');
      return Object.freeze(result);
    }
    await assertCascadeIndexes(client);
    const deleted = await client.query(
      `/* chain-event-prune:delete */ WITH candidates AS MATERIALIZED (
         SELECT event.chain, event.block_hash, event.log_index
           FROM robinhood_chain_events event
           JOIN robinhood_chain_blocks block
             ON block.chain=event.chain AND block.block_hash=event.block_hash
          WHERE event.chain=$1 AND event.block_number < $2
            AND block.block_timestamp < NOW() - ($4::bigint * INTERVAL '1 millisecond')
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
      [CHAIN, cutoffBlock, batchLimit, protectedRetentionMs]
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

async function pruneCanonicalStorageBatch(
  database, cutoffBlock, batchLimit, retentionMs = DEFAULT_RETENTION_MS
) {
  const protectedRetentionMs = boundedInteger(
    retentionMs, DEFAULT_RETENTION_MS, DEFAULT_RETENTION_MS,
    30 * 24 * 60 * 60 * 1000, 'retentionMs'
  );
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const lock = await client.query(
      `/* chain-event-prune:storage-lock */ SELECT pg_try_advisory_xact_lock(
         hashtext('robinhood-chain-event-pruner')) AS locked`
    );
    if (lock.rows[0]?.locked !== true) {
      await client.query('COMMIT');
      return Object.freeze({
        status: 'blocked', reason: 'concurrent_pruner',
        deletedTransactions: 0, deletedBlocks: 0,
      });
    }
    if (!await legacyEventStorage(client)) {
      await client.query('COMMIT');
      return Object.freeze({ status: 'blocked', reason: 'partitioned_events',
        deletedTransactions: 0, deletedBlocks: 0 });
    }
    await assertCanonicalStorageIndexes(client);
    // A transaction delete would cascade into the shadow and create dead rows per event.
    const shadow = await client.query(
      "SELECT to_regclass('robinhood_chain_events_shadow') AS relation"
    );
    const shadowGuard = shadow.rows[0]?.relation ? `WHERE NOT EXISTS (
             SELECT 1 FROM robinhood_chain_events_shadow shadow
              WHERE shadow.chain=transaction.chain
                AND shadow.block_hash=transaction.block_hash
                AND shadow.transaction_hash=transaction.transaction_hash
           )` : '';
    const transactions = await client.query(
      `/* chain-event-prune:transactions */ WITH event_free_blocks AS MATERIALIZED (
         SELECT block.chain, block.block_hash, block.block_number
           FROM robinhood_chain_blocks block
          WHERE block.chain=$1 AND block.block_number < $2::bigint
            AND block.block_timestamp < NOW() - ($4::bigint * INTERVAL '1 millisecond')
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_chain_events event
               WHERE event.chain=block.chain AND event.block_hash=block.block_hash
            )
          ORDER BY block.block_number, block.block_hash
          LIMIT $3::int
       ), candidates AS MATERIALIZED (
         SELECT transaction.ctid
           FROM event_free_blocks block
           JOIN robinhood_chain_transactions transaction
             ON transaction.chain=block.chain AND transaction.block_hash=block.block_hash
          ${shadowGuard}
          ORDER BY block.block_number, transaction.transaction_index
          LIMIT $3::int
          FOR UPDATE OF transaction SKIP LOCKED
       ), removed AS (
         DELETE FROM robinhood_chain_transactions transaction USING candidates
          WHERE transaction.ctid=candidates.ctid RETURNING 1
       ) SELECT COUNT(*)::int AS deleted FROM removed`,
      [CHAIN, cutoffBlock, batchLimit, protectedRetentionMs]
    );
    const blocks = await client.query(
      `/* chain-event-prune:blocks */ WITH candidates AS MATERIALIZED (
         SELECT block.ctid
           FROM robinhood_chain_blocks block
          WHERE block.chain=$1 AND block.block_number < $2::bigint
            AND block.block_timestamp < NOW() - ($4::bigint * INTERVAL '1 millisecond')
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_chain_transactions transaction
               WHERE transaction.chain=block.chain AND transaction.block_hash=block.block_hash
            )
          ORDER BY block.block_number, block.block_hash
          LIMIT $3::int
          FOR UPDATE OF block SKIP LOCKED
       ), removed AS (
         DELETE FROM robinhood_chain_blocks block USING candidates
          WHERE block.ctid=candidates.ctid RETURNING 1
       ) SELECT COUNT(*)::int AS deleted FROM removed`,
      [CHAIN, cutoffBlock, batchLimit, protectedRetentionMs]
    );
    await client.query('COMMIT');
    const deletedTransactions = Number(transactions.rows[0]?.deleted || 0);
    const deletedBlocks = Number(blocks.rows[0]?.deleted || 0);
    return Object.freeze({
      status: deletedTransactions === batchLimit || deletedBlocks === batchLimit
        ? 'draining' : 'prefix_drained',
      deletedTransactions,
      deletedBlocks,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pruneStorage(options, database, cutoffBlock, partitioned) {
  if (!options.pruneCanonicalStorage || partitioned
      || options.partitionPreview || options.partitionDropEnabled) {
    return { status: 'disabled', deletedTransactions: 0, deletedBlocks: 0 };
  }
  return pruneCanonicalStorageBatch(
    database, cutoffBlock, options.batchLimit, options.retentionMs
  );
}

async function drainPrunableBatches(options, deps, database, cutoffBlock) {
  const progress = deps.progress || (() => {});
  const shouldStop = deps.shouldStop || (() => false);
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let batches = 0;
  let totalDeleted = 0;
  let totalDeletedTransactions = 0;
  let totalDeletedBlocks = 0;
  let droppedPartitions = 0;
  let freedBytes = 0n;
  let stopReason = 'batch_limit';
  for (let index = 0; options.untilDrained || index < options.maxBatches; index += 1) {
    if (shouldStop()) { stopReason = 'signal'; break; }
    const result = await pruneBatch(
      database,
      cutoffBlock,
      options.batchLimit,
      options.retentionMs,
      options.partitionDropEnabled,
      options.partitionPreview
    );
    batches += 1;
    totalDeleted += result.deletedEvents;
    droppedPartitions += result.droppedPartitions || 0;
    freedBytes += BigInt(result.freedBytes || 0);
    const storage = await pruneStorage(options, database, cutoffBlock, result.partitioned);
    totalDeletedTransactions += storage.deletedTransactions;
    totalDeletedBlocks += storage.deletedBlocks;
    progress({ phase: 'batch', batch: batches, cutoffBlock, ...result, storage });
    if (result.partitioned) {
      stopReason = result.droppedPartitions ? 'partition_limit' : result.status;
      break;
    }
    const draining = result.status === 'draining' || storage.status === 'draining';
    if (!draining) {
      stopReason = result.status === 'blocked' ? result.status : storage.status;
      if (stopReason === 'disabled') stopReason = result.status;
      break;
    }
    if (options.untilDrained || index + 1 < options.maxBatches) await pause(options.pauseMs);
  }
  return Object.freeze({
    status: 'finished', stopReason, cutoffBlock,
    retentionMs: options.retentionMs, batches, totalDeleted,
    totalDeletedTransactions, totalDeletedBlocks,
    droppedPartitions, freedBytes: String(freedBytes),
  });
}

async function runPilot(input = {}, deps = {}) {
  const options = normalizeOptions(input);
  const database = deps.database || db;
  const audit = deps.audit || createRobinhoodRetentionSafetyAudit({
    database,
    includeHolderProof: false,
  });
  const safety = await audit.inspect();
  if (safety.chain_events?.ready_for_pilot !== true) {
    return Object.freeze({
      status: 'blocked', reason: 'retention_safety_audit', batches: 0,
      totalDeleted: 0, blockers: safety.chain_events?.blockers || [],
    });
  }
  const safetyCutoffBlock = String(safety.chain_events.candidate_cutoff_block || '');
  const journalStartBlock = String(safety.chain_events.journal_start_block || '');
  if (!/^[1-9][0-9]*$/.test(safetyCutoffBlock) || !/^[0-9]+$/.test(journalStartBlock)) {
    throw new Error('Retention safety audit returned an invalid chain event cutoff');
  }
  const resolveCutoff = deps.resolveRetentionCutoff || resolveRetentionCutoff;
  const cutoffBlock = await resolveCutoff(database, {
    journalStartBlock, safetyCutoffBlock, retentionMs: options.retentionMs,
  });
  return drainPrunableBatches(options, deps, database, cutoffBlock);
}

module.exports = {
  DEFAULT_BATCH_LIMIT, DEFAULT_MAX_BATCHES, DEFAULT_RETENTION_MS,
  REQUIRED_INDEXES, REQUIRED_STORAGE_INDEXES,
  assertCanonicalStorageIndexes, assertCascadeIndexes, normalizeOptions,
  pruneBatch, pruneCanonicalStorageBatch, resolveRetentionCutoff, runPilot,
};
