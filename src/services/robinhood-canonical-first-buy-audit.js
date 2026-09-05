'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const MAX_CAPTURE_LAG = 2n;
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  walletSwap: 'robinhood-wallet-swap-live-worker',
  firstBuy: 'robinhood-first-buy-live-worker',
});

function quantity(value) { return value == null ? null : BigInt(value); }
function text(value) { return value == null ? null : String(value); }
function instant(value) {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
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
    running: telemetry.running === true, halted: telemetry.halted === true,
    source_mode: telemetry.sourceMode || null,
    lag_ms: telemetry.lagMs == null ? null : Number(telemetry.lagMs),
    last_error: telemetry.lastError || null,
  });
}
function add(blockers, condition, code, detail = null) {
  if (condition) blockers.push(detail == null ? { code } : { code, detail });
}

function evaluate(input = {}) {
  const row = input.state || {};
  const captureNext = quantity(row.capture_next_block);
  const captureHead = quantity(row.capture_node_head);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const captureLag = distance(captureNext, captureHead);
  const swapNext = quantity(row.swap_next_block);
  const swapCheckpoint = quantity(row.swap_checkpoint_block);
  const firstSourceNext = quantity(row.first_source_next_block);
  const confirmedHead = captureHead == null ? null : captureHead - (captureHead >= 2n ? 2n : captureHead);
  const canonicalSafe = confirmedHead == null || captureCheckpoint == null
    ? null : confirmedHead < captureCheckpoint ? confirmedHead : captureCheckpoint;
  const swapLag = distance(swapNext, canonicalSafe);
  const firstBlockLag = distance(firstSourceNext, swapNext == null ? null : swapNext - 1n);
  const swapCheckpointTime = instant(row.swap_checkpoint_timestamp);
  const swapThrough = swapCheckpointTime == null ? null : new Date(swapCheckpointTime.getTime() + 1);
  const firstNextTime = instant(row.first_next_time);
  const firstSourceThrough = instant(row.first_source_through);
  const firstTimeLagMs = firstNextTime == null || swapThrough == null
    ? null : Math.max(0, swapThrough.getTime() - firstNextTime.getTime());
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, leaseSummary(activeLease(input.leases || [], key))]
  )));
  const blockers = [];

  add(blockers, captureNext == null, 'capture_cursor_missing');
  add(blockers, captureNext != null && captureHead == null, 'capture_head_missing');
  add(blockers, captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(blockers, !leases.capture.active, 'canonical_capture_inactive');
  add(blockers, row.journal_start_block == null, 'canonical_journal_empty');
  add(blockers, swapNext == null, 'wallet_swap_cursor_missing');
  add(blockers, swapNext != null && row.swap_lifecycle_state !== 'running',
    'wallet_swap_not_running', row.swap_lifecycle_state);
  add(blockers, swapNext != null && (swapCheckpoint == null || swapCheckpoint + 1n !== swapNext
    || row.swap_checkpoint_hash == null || swapCheckpointTime == null),
  'wallet_swap_checkpoint_inconsistent');
  add(blockers, swapCheckpoint != null && row.canonical_swap_checkpoint_hash
    !== row.swap_checkpoint_hash, 'wallet_swap_checkpoint_not_canonical');
  add(blockers, !leases.walletSwap.active || !leases.walletSwap.running,
    'wallet_swap_worker_inactive');
  add(blockers, leases.walletSwap.active && leases.walletSwap.running
    && leases.walletSwap.source_mode !== 'canonical_journal',
  'wallet_swap_source_not_canonical', leases.walletSwap.source_mode);
  add(blockers, leases.walletSwap.last_error != null,
    'wallet_swap_worker_error', leases.walletSwap.last_error);
  add(blockers, row.first_seed_run_id == null, 'first_buy_cursor_missing');
  add(blockers, row.first_seed_run_id != null && row.seed_status !== 'completed',
    'first_buy_seed_incomplete', row.seed_status);
  add(blockers, firstNextTime == null || firstSourceThrough == null,
    'first_buy_time_frontier_invalid');
  add(blockers, firstNextTime != null && firstSourceThrough != null
    && firstNextTime > firstSourceThrough, 'first_buy_time_frontier_inconsistent');
  add(blockers, firstNextTime != null && swapThrough != null && firstNextTime > swapThrough,
    'first_buy_ahead_of_wallet_swap');
  add(blockers, row.first_seed_run_id != null && firstSourceNext == null,
    'first_buy_block_frontier_missing');
  add(blockers, firstSourceNext != null && swapNext != null && firstSourceNext > swapNext,
    'first_buy_block_frontier_ahead');
  add(blockers, !leases.firstBuy.active || !leases.firstBuy.running,
    'first_buy_worker_inactive');
  add(blockers, leases.firstBuy.halted, 'first_buy_worker_halted');
  add(blockers, leases.firstBuy.last_error != null,
    'first_buy_worker_error', leases.firstBuy.last_error);

  return Object.freeze({
    mode: 'read-only', ready: blockers.length === 0, blockers,
    capture: {
      next_block: text(captureNext), checkpoint_block: text(captureCheckpoint),
      node_head: text(captureHead), lag_blocks: text(captureLag), safe_head: text(canonicalSafe),
    },
    wallet_swap: {
      next_block: text(swapNext), checkpoint_block: text(swapCheckpoint),
      checkpoint_timestamp: row.swap_checkpoint_timestamp || null,
      lifecycle_state: row.swap_lifecycle_state || null,
      lag_to_canonical_blocks: text(swapLag),
    },
    first_buy: {
      seed_run_id: text(row.first_seed_run_id), seed_status: row.seed_status || null,
      next_time: row.first_next_time || null, source_through: row.first_source_through || null,
      source_next_block: text(firstSourceNext), updated_at: row.first_updated_at || null,
      lag_to_wallet_swap_ms: firstTimeLagMs,
      lag_to_wallet_swap_blocks: text(firstBlockLag),
    },
    dependency: {
      source: 'robinhood_wallet_swaps', canonical_indirect: true,
      direct_rpc_reads: false, direct_chain_journal_reads: false,
    },
    leases,
  });
}

function createRobinhoodCanonicalFirstBuyAudit(options = {}) {
  const database = options.database || db;
  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stateResult = await client.query(
        `SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                journal.block_number AS journal_start_block,
                swap.next_block AS swap_next_block,
                swap.checkpoint_block AS swap_checkpoint_block,
                swap.checkpoint_hash AS swap_checkpoint_hash,
                swap.checkpoint_timestamp AS swap_checkpoint_timestamp,
                swap.lifecycle_state AS swap_lifecycle_state,
                canonical_swap.block_hash AS canonical_swap_checkpoint_hash,
                first_buy.seed_run_id AS first_seed_run_id,
                first_buy.next_time AS first_next_time,
                first_buy.source_through AS first_source_through,
                first_buy.source_next_block AS first_source_next_block,
                first_buy.updated_at AS first_updated_at,
                seed.status AS seed_status
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN robinhood_wallet_swap_cursors swap
             ON swap.chain=$1 AND swap.stream='live'
           LEFT JOIN robinhood_first_buy_live_cursors first_buy ON first_buy.chain=$1
           LEFT JOIN robinhood_first_buy_backfill_runs seed
             ON seed.chain=$1 AND seed.id=first_buy.seed_run_id
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1
           ) journal ON TRUE
           LEFT JOIN robinhood_chain_blocks canonical_swap
             ON canonical_swap.chain=$1 AND canonical_swap.canonical=TRUE
            AND canonical_swap.block_number=swap.checkpoint_block`,
        [CHAIN]
      );
      const leaseResult = await client.query(
        `SELECT lease_key, lease_until > NOW() AS active, heartbeat_at, metadata
           FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
        [Object.values(LEASE_KEYS)]
      );
      await client.query('ROLLBACK');
      return evaluate({ state: stateResult.rows[0] || {}, leases: leaseResult.rows });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = { LEASE_KEYS, createRobinhoodCanonicalFirstBuyAudit, evaluate };
