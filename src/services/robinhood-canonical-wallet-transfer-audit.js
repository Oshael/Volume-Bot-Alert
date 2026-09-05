'use strict';

const db = require('../models/db');
const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');
const { CLASSIFICATION_VERSION } = require('./robinhood-wallet-transfer-batch');
const {
  UNIFIED_POSITION_VERSION,
} = require('./robinhood-wallet-unified-position-batch');

const CHAIN = 'robinhood';
const DEFAULT_CONFIRMATIONS = 2;
const MAX_CAPTURE_LAG = 2n;
const MAX_CONTEXT_BLOCKS = 200n;
const PHASES = Object.freeze(['preflight', 'cutover']);
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  swap: 'robinhood-wallet-swap-live-worker',
  transfer: 'robinhood-wallet-transfer-live-worker',
});

function quantity(value) { return value == null ? null : BigInt(value); }
function text(value) { return value == null ? null : String(value); }
function count(value) { return Number(value ?? 0); }
function phase(value) {
  const normalized = String(value || 'preflight').trim().toLowerCase();
  if (!PHASES.includes(normalized)) throw new Error(`phase must be ${PHASES.join(' or ')}`);
  return normalized;
}
function preferredText(value, fallback) { return text(value ?? fallback); }
function positionAlignment(row) {
  if (row.position_live_next_block == null || row.transfer_next_block == null) return null;
  return String(row.position_live_next_block) === String(row.transfer_next_block);
}
function distance(first, last) {
  return first == null || last == null || last < first ? 0n : last - first + 1n;
}
function minimum(...values) {
  return values.reduce((result, value) => (value < result ? value : result));
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
    source_mode: telemetry.sourceMode || null, lag_blocks: text(telemetry.lagBlocks),
    last_error: telemetry.lastError || null,
  });
}

function frontiers(row, confirmations) {
  const captureNext = quantity(row.capture_next_block);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const captureHead = quantity(row.capture_node_head);
  const journalStart = quantity(row.journal_start_block);
  const swapNext = quantity(row.swap_next_block);
  const swapCheckpoint = quantity(row.swap_checkpoint_block);
  const transferNext = quantity(row.transfer_next_block);
  const transferCheckpoint = quantity(row.transfer_checkpoint_block);
  const confirmedHead = captureHead == null ? null
    : captureHead >= BigInt(confirmations) ? captureHead - BigInt(confirmations) : 0n;
  const canonicalSafe = confirmedHead == null || captureCheckpoint == null
    ? null : minimum(confirmedHead, captureCheckpoint);
  const swapThrough = swapNext == null || swapNext === 0n ? null : swapNext - 1n;
  const contextFirst = transferNext == null || journalStart == null
    ? null : transferNext > journalStart ? transferNext : journalStart;
  const contextLast = contextFirst == null || swapThrough == null || contextFirst > swapThrough
    ? null : minimum(contextFirst + MAX_CONTEXT_BLOCKS - 1n, swapThrough);
  return {
    captureNext, captureCheckpoint, captureHead, canonicalSafe,
    captureLag: distance(captureNext, captureHead), journalStart,
    swapNext, swapCheckpoint, swapThrough,
    transferNext, transferCheckpoint,
    swapLag: distance(swapNext, canonicalSafe), transferLag: distance(transferNext, swapThrough),
    preJournal: distance(transferNext, journalStart == null ? null : journalStart - 1n),
    contextFirst, contextLast,
  };
}

function add(blockers, condition, code, detail = null) {
  if (condition) blockers.push(detail == null ? { code } : { code, detail });
}

function addCheckpointBlockers(blockers, prefix, row, next, checkpoint, canonicalHash) {
  const complete = checkpoint != null && row[`${prefix}_checkpoint_hash`] != null;
  const sequential = complete && next != null && checkpoint + 1n === next;
  add(blockers, next != null && !sequential, `${prefix}_checkpoint_inconsistent`);
  add(blockers, sequential && canonicalHash !== row[`${prefix}_checkpoint_hash`],
    `${prefix}_checkpoint_not_canonical`);
}

function captureBlockers(cursor, leases) {
  const blockers = [];
  add(blockers, cursor.captureNext == null, 'capture_cursor_missing');
  add(blockers, cursor.captureNext != null && cursor.captureHead == null, 'capture_head_missing');
  add(blockers, cursor.captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(cursor.captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(blockers, !leases.capture.active, 'canonical_capture_inactive');
  add(blockers, cursor.journalStart == null, 'canonical_journal_empty');
  return blockers;
}

function swapBlockers(row, cursor, lease) {
  const blockers = [];
  add(blockers, cursor.swapNext == null, 'wallet_swap_cursor_missing');
  add(blockers, cursor.swapNext != null && row.swap_lifecycle_state !== 'running',
    'wallet_swap_not_running', row.swap_lifecycle_state);
  addCheckpointBlockers(
    blockers, 'swap', row, cursor.swapNext, cursor.swapCheckpoint,
    row.canonical_swap_checkpoint_hash
  );
  add(blockers, !lease.active, 'wallet_swap_worker_inactive');
  add(blockers, lease.active && (!lease.running || lease.halted),
    'wallet_swap_worker_not_running');
  add(blockers, lease.active && lease.running && lease.source_mode !== 'canonical_journal',
    'wallet_swap_source_not_canonical', lease.source_mode);
  add(blockers, lease.last_error != null, 'wallet_swap_worker_error', lease.last_error);
  return blockers;
}

function transferBlockers(row, context, cursor, lease, active, auditPhase) {
  const blockers = [];
  add(blockers, cursor.transferNext == null, 'wallet_transfer_cursor_missing');
  add(blockers, cursor.transferNext != null && row.transfer_lifecycle_state !== 'running',
    'wallet_transfer_not_running', row.transfer_lifecycle_state);
  addCheckpointBlockers(blockers, 'transfer', row, cursor.transferNext,
    cursor.transferCheckpoint, row.canonical_transfer_checkpoint_hash);
  add(blockers, cursor.preJournal > 0n,
    'wallet_transfer_before_canonical_journal', text(cursor.preJournal));
  add(blockers, cursor.preJournal > 0n && !active, 'wallet_transfer_catchup_inactive');
  add(blockers, cursor.transferNext != null && cursor.swapThrough != null
    && cursor.transferNext > cursor.swapThrough + 1n, 'wallet_transfer_ahead_of_source');
  add(blockers, Number(context.missing_blocks || 0) > 0, 'canonical_block_context_missing', {
    count: Number(context.missing_blocks), first_block: text(context.first_missing_block),
  });
  add(blockers, Number(context.malformed_in_scope_events || 0) > 0,
    'canonical_transfer_evidence_invalid', Number(context.malformed_in_scope_events));
  add(blockers, lease.halted, 'wallet_transfer_worker_halted');
  add(blockers, lease.last_error != null, 'wallet_transfer_worker_error', lease.last_error);
  if (auditPhase === 'cutover') {
    add(blockers, !active, 'wallet_transfer_worker_inactive');
    add(blockers, active && !lease.running, 'wallet_transfer_worker_not_running');
    add(blockers, active && lease.running && lease.source_mode !== 'canonical_journal',
      'wallet_transfer_source_not_canonical', lease.source_mode);
  }
  return blockers;
}

function evaluate(input = {}) {
  const row = input.state || {};
  const context = input.context || {};
  const auditPhase = phase(input.phase);
  const confirmations = Number(input.confirmations ?? DEFAULT_CONFIRMATIONS);
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 1000) {
    throw new Error('confirmations must be between 0 and 1000');
  }
  const cursor = frontiers(row, confirmations);
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, activeLease(input.leases || [], key)]
  )));
  const swapLease = leaseSummary(leases.swap);
  const transferLease = leaseSummary(leases.transfer);
  const blockers = [
    ...captureBlockers(cursor, leases), ...swapBlockers(row, cursor, swapLease),
    ...transferBlockers(
      row, context, cursor, transferLease, leases.transfer.active, auditPhase
    ),
  ];
  return Object.freeze({
    mode: 'read-only', phase: auditPhase, ready: blockers.length === 0, blockers,
    capture: { next_block: text(cursor.captureNext), checkpoint_block: text(cursor.captureCheckpoint),
      node_head: text(cursor.captureHead), lag_blocks: text(cursor.captureLag), confirmations,
      safe_head: text(cursor.canonicalSafe) },
    wallet_swap: { next_block: text(cursor.swapNext), checkpoint_block: text(cursor.swapCheckpoint),
      safe_head: text(row.swap_safe_head), through_block: text(cursor.swapThrough),
      lag_to_canonical_safe_head: text(cursor.swapLag),
      lifecycle_state: text(row.swap_lifecycle_state) },
    wallet_transfer: { origin_block: text(row.transfer_origin_block),
      next_block: text(cursor.transferNext), checkpoint_block: text(cursor.transferCheckpoint),
      safe_head: text(row.transfer_safe_head), lifecycle_state: text(row.transfer_lifecycle_state),
      updated_at: text(row.transfer_updated_at), lag_to_wallet_swap_blocks: text(cursor.transferLag) },
    handoff: { journal_start_block: text(cursor.journalStart),
      pre_journal_blocks_remaining: text(cursor.preJournal),
      checkpoint_canonical: row.canonical_transfer_checkpoint_hash != null
        && row.canonical_transfer_checkpoint_hash === row.transfer_checkpoint_hash },
    scope: { tracked_tokens: count(row.tracked_tokens),
      ledger_statuses: input.tokens ?? {} },
    context: { first_block: preferredText(context.checked_first_block, cursor.contextFirst),
      last_block: preferredText(context.checked_last_block, cursor.contextLast),
      max_blocks: text(MAX_CONTEXT_BLOCKS), expected_blocks: count(context.expected_blocks),
      canonical_blocks: count(context.canonical_blocks),
      transfer_events: count(context.transfer_events),
      in_scope_events: count(context.in_scope_events),
      malformed_in_scope_events: count(context.malformed_in_scope_events),
      missing_blocks: count(context.missing_blocks) },
    unified_position: { seed_next_block: text(row.position_seed_next_block),
      seed_state: text(row.position_seed_state), live_next_block: text(row.position_live_next_block),
      live_state: text(row.position_live_state), aligned_with_transfer: positionAlignment(row) },
    leases: { capture: leaseSummary(leases.capture), wallet_swap: swapLease,
      wallet_transfer: transferLease },
  });
}

function trackedTokensSql() {
  return `SELECT token_address FROM robinhood_holder_token_states
           WHERE chain=$1 AND ledger_status IN ('backfilling', 'shadow', 'live')
          UNION
          SELECT token.token_address FROM robinhood_holder_global_backfill_tokens token
          JOIN robinhood_holder_global_backfill_runs run
            ON run.id=token.run_id AND run.chain=token.chain
           WHERE token.chain=$1 AND token.status='active'
             AND run.barrier_block IS NOT NULL AND run.status<>'completed'`;
}

function createRobinhoodCanonicalWalletTransferAudit(options = {}) {
  const database = options.database || db;
  const confirmations = options.confirmations ?? DEFAULT_CONFIRMATIONS;
  const auditPhase = phase(options.phase);
  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = (await client.query(`WITH tracked AS MATERIALIZED (${trackedTokensSql()})
        SELECT capture.next_block AS capture_next_block,
               capture.checkpoint_block AS capture_checkpoint_block,
               capture.node_head AS capture_node_head, journal.block_number AS journal_start_block,
               swap.next_block AS swap_next_block, swap.safe_head AS swap_safe_head,
               swap.checkpoint_block AS swap_checkpoint_block,
               swap.checkpoint_hash AS swap_checkpoint_hash,
               swap.lifecycle_state AS swap_lifecycle_state,
               transfer.origin_block AS transfer_origin_block,
               transfer.next_block AS transfer_next_block,
               transfer.safe_head AS transfer_safe_head,
               transfer.checkpoint_block AS transfer_checkpoint_block,
               transfer.checkpoint_hash AS transfer_checkpoint_hash,
               transfer.lifecycle_state AS transfer_lifecycle_state,
               transfer.updated_at AS transfer_updated_at,
               swap_block.block_hash AS canonical_swap_checkpoint_hash,
               transfer_block.block_hash AS canonical_transfer_checkpoint_hash,
               position_seed.next_block AS position_seed_next_block,
               position_seed.lifecycle_state AS position_seed_state,
               position_live.next_block AS position_live_next_block,
               position_live.lifecycle_state AS position_live_state,
               (SELECT COUNT(*) FROM tracked) AS tracked_tokens
          FROM (VALUES (1)) anchor(value)
          LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
          LEFT JOIN robinhood_wallet_swap_cursors swap
            ON swap.chain=$1 AND swap.stream='live'
          LEFT JOIN robinhood_wallet_transfer_cursors transfer
            ON transfer.chain=$1 AND transfer.projection_version=$2 AND transfer.stream='live'
          LEFT JOIN LATERAL (SELECT block_number FROM robinhood_chain_blocks
            WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1) journal ON TRUE
          LEFT JOIN robinhood_chain_blocks swap_block ON swap_block.chain=$1
            AND swap_block.canonical=TRUE AND swap_block.block_number=swap.checkpoint_block
          LEFT JOIN robinhood_chain_blocks transfer_block ON transfer_block.chain=$1
            AND transfer_block.canonical=TRUE AND transfer_block.block_number=transfer.checkpoint_block
          LEFT JOIN robinhood_wallet_position_cursors position_seed ON position_seed.chain=$1
            AND position_seed.projection_version=$3 AND position_seed.stream='seed'
          LEFT JOIN robinhood_wallet_position_cursors position_live ON position_live.chain=$1
            AND position_live.projection_version=$3 AND position_live.stream='live'`,
      [CHAIN, CLASSIFICATION_VERSION, UNIFIED_POSITION_VERSION])).rows[0] || {};
      const cursor = frontiers(state, confirmations);
      let context = {};
      if (cursor.contextFirst != null && cursor.contextLast != null) {
        const result = await client.query(`WITH tracked AS MATERIALIZED (${trackedTokensSql()}),
          expected AS MATERIALIZED (
            SELECT generate_series($2::bigint, $3::bigint) AS block_number
          ), coverage AS MATERIALIZED (
            SELECT expected.block_number, block.block_hash, block.block_number IS NULL AS missing
              FROM expected LEFT JOIN robinhood_chain_blocks block
                ON block.chain=$1 AND block.canonical=TRUE
               AND block.block_number=expected.block_number
          ), events AS MATERIALIZED (
            SELECT event.* FROM coverage JOIN robinhood_chain_events event
              ON event.chain=$1 AND event.block_hash=coverage.block_hash
             AND event.topic0=$4
          ), scoped AS MATERIALIZED (
            SELECT event.* FROM events event JOIN tracked ON tracked.token_address=event.address
          )
          SELECT (SELECT COUNT(*) FROM expected) AS expected_blocks,
                 COUNT(*) FILTER (WHERE NOT missing) AS canonical_blocks,
                 COUNT(*) FILTER (WHERE missing) AS missing_blocks,
                 MIN(block_number) FILTER (WHERE missing) AS first_missing_block,
                 (SELECT COUNT(*) FROM events) AS transfer_events,
                 (SELECT COUNT(*) FROM scoped) AS in_scope_events,
                 (SELECT COUNT(*) FROM scoped WHERE jsonb_array_length(topics)<>3
                   OR data !~ '^0x[0-9a-f]{64}$'
                   OR topics->>1 !~ '^0x0{24}[0-9a-f]{40}$'
                   OR topics->>2 !~ '^0x0{24}[0-9a-f]{40}$') AS malformed_in_scope_events
            FROM coverage`, [CHAIN, text(cursor.contextFirst), text(cursor.contextLast), TRANSFER_TOPIC]);
        context = { ...result.rows[0], checked_first_block: text(cursor.contextFirst),
          checked_last_block: text(cursor.contextLast) };
      }
      const tokenRows = await client.query(`SELECT ledger_status, COUNT(*) AS tokens
        FROM robinhood_holder_token_states WHERE chain=$1 GROUP BY ledger_status`, [CHAIN]);
      const leaseRows = await client.query(`SELECT lease_key, lease_until>NOW() AS active,
        heartbeat_at, metadata FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
      [Object.values(LEASE_KEYS)]);
      await client.query('ROLLBACK');
      return evaluate({ state, context,
        tokens: Object.fromEntries(tokenRows.rows.map((row) => [row.ledger_status, Number(row.tokens)])),
        leases: leaseRows.rows, confirmations, phase: auditPhase });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = { DEFAULT_CONFIRMATIONS, LEASE_KEYS, MAX_CONTEXT_BLOCKS, PHASES,
  createRobinhoodCanonicalWalletTransferAudit, evaluate };
