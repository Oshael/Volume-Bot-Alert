'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const MAX_CAPTURE_LAG = 2n;
const SAMPLE_EDGE_BLOCKS = 100n;
const PHASES = new Set(['preflight', 'cutover']);
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  firstBuy: 'robinhood-first-buy-live-worker',
  launchAnchor: 'robinhood-launch-anchor-live-worker',
  bundleFunding: 'robinhood-bundle-funding-live-worker',
});

function quantity(value) { return value == null ? null : BigInt(value); }
function text(value) { return value == null ? null : String(value); }
function distance(first, last) {
  return first == null || last == null || last < first ? 0n : last - first + 1n;
}
function activeLease(rows, key) {
  return rows.find((row) => row.lease_key === key) || {
    lease_key: key, active: false, heartbeat_at: null, metadata: {},
  };
}
function leaseSummary(lease) {
  const telemetry = lease.metadata?.telemetry || lease.metadata || {};
  return Object.freeze({
    active: Boolean(lease.active), heartbeat_at: lease.heartbeat_at || null,
    running: telemetry.running === true, source_mode: telemetry.sourceMode || null,
    last_error: telemetry.lastError || null,
  });
}
function add(blockers, condition, code, detail = null) {
  if (condition) blockers.push(detail == null ? { code } : { code, detail });
}

function validateCapture(blockers, values) {
  add(blockers, values.captureNext == null, 'capture_cursor_missing');
  add(blockers, values.captureNext != null && values.captureHead == null,
    'capture_head_missing');
  add(blockers, values.captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(values.captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(blockers, !values.leases.capture.active, 'canonical_capture_inactive');
  add(blockers, values.journalStart == null || values.journalThrough == null,
    'canonical_journal_empty');
}

function validateDependencies(blockers, row, leases) {
  add(blockers, row.first_seed_run_id == null, 'first_buy_cursor_missing');
  add(blockers, row.first_seed_run_id != null && row.first_seed_status !== 'completed',
    'first_buy_seed_incomplete', row.first_seed_status || null);
  add(blockers, row.first_source_next_block == null, 'first_buy_frontier_missing');
  add(blockers, !leases.firstBuy.active || !leases.firstBuy.running,
    'first_buy_worker_inactive');
  add(blockers, leases.firstBuy.last_error != null,
    'first_buy_worker_error', leases.firstBuy.last_error);
  add(blockers, !leases.launchAnchor.active || !leases.launchAnchor.running,
    'launch_anchor_worker_inactive');
  add(blockers, leases.launchAnchor.last_error != null,
    'launch_anchor_worker_error', leases.launchAnchor.last_error);
}

function validateCoverage(blockers, values) {
  add(blockers, values.beforeJournal > 0n,
    'bundle_funding_before_journal', text(values.beforeJournal));
  add(blockers, values.notCaptured > 0n,
    'bundle_funding_range_not_captured', text(values.notCaptured));
  add(blockers, values.sampleBlocks > 0 && values.missingBlocks > 0,
    'canonical_sample_missing_blocks', values.missingBlocks);
  add(blockers, values.missingValues > 0,
    'canonical_sample_missing_transaction_values', values.missingValues);
}

function validateBundleWorker(blockers, values) {
  const { bundleFunding } = values.leases;
  add(blockers, values.phase === 'preflight' && values.activeTasks > 0
    && (!bundleFunding.active || !bundleFunding.running),
  'bundle_funding_worker_inactive');
  add(blockers, bundleFunding.last_error != null,
    'bundle_funding_worker_error', bundleFunding.last_error);
  add(blockers, values.phase === 'cutover'
    && (!bundleFunding.active || !bundleFunding.running),
  'bundle_funding_worker_inactive');
  add(blockers, values.phase === 'cutover' && bundleFunding.active
    && bundleFunding.running && bundleFunding.source_mode !== 'canonical_journal',
  'bundle_funding_source_not_canonical', bundleFunding.source_mode);
}

function evaluate(input = {}) {
  const phase = input.phase || 'preflight';
  if (!PHASES.has(phase)) throw new Error(`unsupported phase: ${phase}`);
  const row = input.state || {};
  const sample = input.sample || {};
  const captureNext = quantity(row.capture_next_block);
  const captureHead = quantity(row.capture_node_head);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const captureLag = distance(captureNext, captureHead);
  const journalStart = quantity(row.journal_start_block);
  const journalThrough = quantity(row.journal_through_block);
  const requiredStart = quantity(row.required_start_block);
  const requiredThrough = quantity(row.required_through_block);
  const activeTasks = Number(row.active_tasks || 0);
  const sampleBlocks = Number(sample.sample_blocks || 0);
  const missingBlocks = Number(sample.missing_blocks || 0);
  const missingValues = Number(sample.missing_value_transactions || 0);
  const beforeJournal = distance(requiredStart,
    journalStart == null ? null : journalStart - 1n);
  const notCaptured = distance(
    journalThrough == null ? null : journalThrough + 1n, requiredThrough
  );
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, leaseSummary(activeLease(input.leases || [], key))]
  )));
  const blockers = [];

  validateCapture(blockers, {
    captureNext, captureHead, captureLag, journalStart, journalThrough, leases,
  });
  validateDependencies(blockers, row, leases);
  validateCoverage(blockers, {
    beforeJournal, notCaptured, sampleBlocks, missingBlocks, missingValues,
  });
  validateBundleWorker(blockers, { phase, activeTasks, leases });

  return Object.freeze({
    mode: 'read-only', phase, ready: blockers.length === 0, blockers,
    capture: {
      next_block: text(captureNext), checkpoint_block: text(captureCheckpoint),
      node_head: text(captureHead), lag_blocks: text(captureLag),
    },
    queue: {
      total: Number(row.total_tasks || 0), pending: Number(row.pending_tasks || 0),
      leased: Number(row.leased_tasks || 0), active: activeTasks,
      required_start_block: text(requiredStart), required_through_block: text(requiredThrough),
    },
    handoff: {
      journal_start_block: text(journalStart), journal_through_block: text(journalThrough),
      pre_journal_blocks_remaining: text(beforeJournal),
      required_blocks_not_captured: text(notCaptured),
    },
    context: {
      sampled_blocks: sampleBlocks, missing_blocks: missingBlocks,
      transactions: Number(sample.transactions || 0),
      positive_native_transfers: Number(sample.positive_native_transfers || 0),
      missing_value_transactions: missingValues,
      sample_edge_blocks: Number(SAMPLE_EDGE_BLOCKS),
    },
    contract: {
      source: 'robinhood_chain_blocks+robinhood_chain_transactions',
      top_level_native_transfers: 'covered', internal_native_transfers: 'out_of_scope',
    },
    leases,
  });
}

function createRobinhoodCanonicalBundleFundingAudit(options = {}) {
  const database = options.database || db;
  async function inspect(input = {}) {
    const phase = input.phase || 'preflight';
    if (!PHASES.has(phase)) throw new Error(`unsupported phase: ${phase}`);
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stateResult = await client.query(
        `SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                journal_start.block_number AS journal_start_block,
                journal_end.block_number AS journal_through_block,
                queue.total_tasks, queue.pending_tasks, queue.leased_tasks,
                queue.active_tasks, queue.required_start_block,
                queue.required_through_block,
                first_buy.seed_run_id AS first_seed_run_id,
                first_buy.source_next_block AS first_source_next_block,
                seed.status AS first_seed_status
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN robinhood_first_buy_live_cursors first_buy ON first_buy.chain=$1
           LEFT JOIN robinhood_first_buy_backfill_runs seed
             ON seed.chain=$1 AND seed.id=first_buy.seed_run_id
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1
           ) journal_start ON TRUE
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain=$1 AND canonical=TRUE ORDER BY block_number DESC LIMIT 1
           ) journal_end ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS total_tasks,
                    COUNT(*) FILTER (WHERE status='pending') AS pending_tasks,
                    COUNT(*) FILTER (WHERE status='leased') AS leased_tasks,
                    COUNT(*) FILTER (WHERE status<>'complete') AS active_tasks,
                    MIN(GREATEST(anchor_block-lookback_blocks, 0))
                      AS required_start_block,
                    MAX(source_through_block) AS required_through_block
               FROM robinhood_bundle_funding_live_queue WHERE chain=$1
           ) queue ON TRUE`, [CHAIN]
      );
      const state = stateResult.rows[0] || {};
      const requiredStart = quantity(state.required_start_block);
      const requiredThrough = quantity(state.required_through_block);
      const journalStart = quantity(state.journal_start_block);
      const journalThrough = quantity(state.journal_through_block);
      let sample = {};
      if (requiredStart != null && requiredThrough != null
          && journalStart != null && journalThrough != null) {
        const from = requiredStart > journalStart ? requiredStart : journalStart;
        const through = requiredThrough < journalThrough ? requiredThrough : journalThrough;
        if (from <= through) {
          const result = await client.query(
            `WITH edge_blocks AS MATERIALIZED (
               SELECT generate_series($2::bigint,
                        LEAST($3::bigint, $2::bigint+$4::bigint-1)) AS block_number
               UNION
               SELECT generate_series(GREATEST($2::bigint, $3::bigint-$4::bigint+1),
                        $3::bigint)
             ), canonical AS MATERIALIZED (
               SELECT edge.block_number, block.block_hash
                 FROM edge_blocks edge LEFT JOIN robinhood_chain_blocks block
                   ON block.chain=$1 AND block.canonical=TRUE
                  AND block.block_number=edge.block_number
             )
             SELECT (SELECT COUNT(*) FROM edge_blocks) AS sample_blocks,
                    (SELECT COUNT(*) FROM canonical WHERE block_hash IS NULL) AS missing_blocks,
                    COUNT(transaction.transaction_hash) AS transactions,
                    COUNT(transaction.transaction_hash) FILTER (
                      WHERE transaction.value_wei IS NULL
                    ) AS missing_value_transactions,
                    COUNT(transaction.transaction_hash) FILTER (
                      WHERE transaction.value_wei > 0 AND transaction.to_address IS NOT NULL
                    ) AS positive_native_transfers
               FROM canonical
               LEFT JOIN robinhood_chain_transactions transaction
                 ON transaction.chain=$1 AND transaction.block_hash=canonical.block_hash`,
            [CHAIN, from.toString(), through.toString(), SAMPLE_EDGE_BLOCKS.toString()]
          );
          sample = result.rows[0] || {};
        }
      }
      const leaseResult = await client.query(
        `SELECT lease_key, lease_until > NOW() AS active, heartbeat_at, metadata
           FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
        [Object.values(LEASE_KEYS)]
      );
      await client.query('ROLLBACK');
      return evaluate({ phase, state, sample, leases: leaseResult.rows });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = { LEASE_KEYS, createRobinhoodCanonicalBundleFundingAudit, evaluate };
