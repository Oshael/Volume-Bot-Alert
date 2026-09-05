'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const DEFAULT_CONFIRMATIONS = 2;
const MAX_CAPTURE_LAG = 2n;
const MAX_CONTEXT_BLOCKS = 200n;
const PHASES = Object.freeze(['preflight', 'cutover']);
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  signedOrigin: 'robinhood-signed-origin-live-worker',
});

function quantity(value) { return value == null ? null : BigInt(value); }
function text(value) { return value == null ? null : String(value); }
function distance(first, last) {
  return first == null || last == null || last < first ? 0n : last - first + 1n;
}

function confirmationCount(value) {
  const parsed = Number(value ?? DEFAULT_CONFIRMATIONS);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error('confirmations must be between 0 and 1000');
  }
  return parsed;
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
    last_error: telemetry.lastError || null,
  });
}

function phase(value) {
  const normalized = String(value || 'preflight').trim().toLowerCase();
  if (!PHASES.includes(normalized)) throw new Error(`phase must be ${PHASES.join(' or ')}`);
  return normalized;
}

function calculateFrontiers(row, confirmations) {
  const captureNext = quantity(row.capture_next_block);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const captureHead = quantity(row.capture_node_head);
  const journalStart = quantity(row.journal_start_block);
  const liveNext = quantity(row.live_next_block);
  const liveCheckpoint = quantity(row.live_checkpoint_block);
  const confirmedHead = captureHead == null ? null
    : captureHead >= BigInt(confirmations) ? captureHead - BigInt(confirmations) : 0n;
  const canonicalSafeHead = confirmedHead == null || captureCheckpoint == null
    ? null : confirmedHead < captureCheckpoint ? confirmedHead : captureCheckpoint;
  const contextFirst = liveNext == null || journalStart == null
    ? null : liveNext > journalStart ? liveNext : journalStart;
  const contextLast = contextFirst == null || canonicalSafeHead == null
    ? null : [contextFirst + MAX_CONTEXT_BLOCKS - 1n, canonicalSafeHead]
      .reduce((minimum, value) => (value < minimum ? value : minimum));
  return {
    captureNext, captureCheckpoint, captureHead,
    captureLag: distance(captureNext, captureHead), journalStart,
    liveNext, liveCheckpoint, canonicalSafeHead,
    preJournalBlocks: distance(liveNext, journalStart == null ? null : journalStart - 1n),
    canonicalBacklog: distance(liveNext, canonicalSafeHead), contextFirst, contextLast,
  };
}

function blockersFor(row, context, frontiers, leases, auditPhase) {
  const blockers = [];
  const add = (condition, code, detail = null) => {
    if (condition) blockers.push(detail == null ? { code } : { code, detail });
  };
  const checkpointFields = [
    row.live_checkpoint_block, row.live_checkpoint_hash, row.live_checkpoint_timestamp,
  ];
  const checkpointComplete = checkpointFields.every((value) => value != null);
  const checkpointSequence = checkpointComplete && frontiers.liveNext != null
    && frontiers.liveCheckpoint + 1n === frontiers.liveNext;
  const checkpointCanonical = checkpointSequence
    && row.canonical_live_checkpoint_hash === row.live_checkpoint_hash;
  const worker = leaseSummary(leases.signedOrigin);

  add(frontiers.captureNext == null, 'capture_cursor_missing');
  add(frontiers.captureNext != null && frontiers.captureHead == null, 'capture_head_missing');
  add(frontiers.captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(frontiers.captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(!leases.capture.active, 'canonical_capture_inactive');
  add(frontiers.journalStart == null, 'canonical_journal_empty');
  add(row.seed_lifecycle_state == null, 'signed_origin_seed_missing');
  add(row.seed_lifecycle_state != null && row.seed_lifecycle_state !== 'completed',
    'signed_origin_seed_incomplete', row.seed_lifecycle_state);
  add(frontiers.liveNext == null, 'signed_origin_live_cursor_missing');
  add(frontiers.liveNext != null && !['running', 'caught_up'].includes(row.live_lifecycle_state),
    'signed_origin_live_state_invalid', row.live_lifecycle_state);
  add(frontiers.liveNext != null && !checkpointSequence,
    'signed_origin_live_checkpoint_inconsistent');
  add(checkpointSequence && !checkpointCanonical,
    'signed_origin_live_checkpoint_not_canonical');
  add(frontiers.preJournalBlocks > 0n, 'signed_origin_before_canonical_journal',
    text(frontiers.preJournalBlocks));
  add(frontiers.preJournalBlocks > 0n && !worker.active, 'signed_origin_catchup_inactive');
  add(frontiers.liveCheckpoint != null && frontiers.canonicalSafeHead != null
    && frontiers.liveCheckpoint > frontiers.canonicalSafeHead,
  'signed_origin_ahead_of_canonical_capture', {
    signed_origin: text(frontiers.liveCheckpoint), capture: text(frontiers.canonicalSafeHead),
  });
  add(Number(context.missing_blocks || 0) > 0, 'canonical_block_context_missing', {
    count: Number(context.missing_blocks), first_block: text(context.first_missing_block),
  });
  add(Number(context.transactions_missing_nonce || 0) > 0,
    'canonical_transaction_nonce_missing', Number(context.transactions_missing_nonce));
  add(worker.halted, 'signed_origin_worker_halted');
  add(worker.last_error != null, 'signed_origin_worker_error', worker.last_error);
  if (auditPhase === 'cutover') {
    add(!worker.active, 'signed_origin_worker_inactive');
    add(worker.active && !worker.running, 'signed_origin_worker_not_running');
    add(worker.active && worker.running && worker.source_mode !== 'canonical_journal',
      'signed_origin_source_not_canonical', worker.source_mode);
  }
  return blockers;
}

function evaluate(input = {}) {
  const row = input.state || {};
  const context = input.context || {};
  const auditPhase = phase(input.phase);
  const confirmations = confirmationCount(input.confirmations);
  const frontiers = calculateFrontiers(row, confirmations);
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, activeLease(input.leases || [], key)]
  )));
  const blockers = blockersFor(row, context, frontiers, leases, auditPhase);
  return Object.freeze({
    mode: 'read-only', phase: auditPhase, ready: blockers.length === 0, blockers,
    capture: {
      next_block: text(frontiers.captureNext), checkpoint_block: text(frontiers.captureCheckpoint),
      node_head: text(frontiers.captureHead), lag_blocks: text(frontiers.captureLag),
      confirmations, safe_head: text(frontiers.canonicalSafeHead),
    },
    signed_origin: {
      origin_block: text(row.live_origin_block), next_block: text(frontiers.liveNext),
      checkpoint_block: text(frontiers.liveCheckpoint), safe_head: text(row.live_safe_head),
      lifecycle_state: row.live_lifecycle_state || null, updated_at: row.live_updated_at || null,
      lag_to_canonical_safe_head: text(frontiers.canonicalBacklog),
    },
    seed: {
      lifecycle_state: row.seed_lifecycle_state || null,
      next_block: text(row.seed_next_block), safe_head: text(row.seed_safe_head),
    },
    handoff: {
      journal_start_block: text(frontiers.journalStart),
      pre_journal_blocks_remaining: text(frontiers.preJournalBlocks),
      checkpoint_canonical: row.canonical_live_checkpoint_hash != null
        && row.canonical_live_checkpoint_hash === row.live_checkpoint_hash,
      legacy_discovery_safe_head: text(row.legacy_discovery_safe_head),
    },
    context: {
      first_block: text(context.checked_first_block ?? frontiers.contextFirst),
      last_block: text(context.checked_last_block ?? frontiers.contextLast),
      max_blocks: text(MAX_CONTEXT_BLOCKS), expected_blocks: Number(context.expected_blocks || 0),
      canonical_blocks: Number(context.canonical_blocks || 0),
      transactions: Number(context.transactions || 0),
      transactions_missing_nonce: Number(context.transactions_missing_nonce || 0),
      missing_blocks: Number(context.missing_blocks || 0),
    },
    leases: {
      capture: leaseSummary(leases.capture), signed_origin: leaseSummary(leases.signedOrigin),
    },
  });
}

function createRobinhoodCanonicalSignedOriginAudit(options = {}) {
  const database = options.database || db;
  const auditPhase = phase(options.phase);
  const confirmations = options.confirmations
    ?? process.env.ROBINHOOD_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS;

  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stateResult = await client.query(
        `SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                live.origin_block AS live_origin_block, live.next_block AS live_next_block,
                live.safe_head AS live_safe_head,
                live.checkpoint_block AS live_checkpoint_block,
                live.checkpoint_hash AS live_checkpoint_hash,
                live.checkpoint_timestamp AS live_checkpoint_timestamp,
                live.lifecycle_state AS live_lifecycle_state, live.updated_at AS live_updated_at,
                seed.next_block AS seed_next_block, seed.safe_head AS seed_safe_head,
                seed.lifecycle_state AS seed_lifecycle_state,
                journal.block_number AS journal_start_block,
                canonical_live.block_hash AS canonical_live_checkpoint_hash,
                legacy.safe_head AS legacy_discovery_safe_head
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN robinhood_wallet_signed_origin_cursors live
             ON live.chain=$1 AND live.stream='live'
           LEFT JOIN robinhood_wallet_signed_origin_cursors seed
             ON seed.chain=$1 AND seed.stream='seed'
           LEFT JOIN robinhood_head_capture_cursors legacy
             ON legacy.chain=$1 AND legacy.stream='discovery'
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1
           ) journal ON TRUE
           LEFT JOIN robinhood_chain_blocks canonical_live
             ON canonical_live.chain=$1 AND canonical_live.canonical=TRUE
            AND canonical_live.block_number=live.checkpoint_block`,
        [CHAIN]
      );
      const state = stateResult.rows[0] || {};
      const frontiers = calculateFrontiers(state, confirmations);
      let context = {};
      if (frontiers.contextFirst != null && frontiers.contextLast != null
          && frontiers.contextFirst <= frontiers.contextLast) {
        const result = await client.query(
          `WITH expected AS MATERIALIZED (
             SELECT generate_series($2::bigint, $3::bigint) AS block_number
           ), coverage AS MATERIALIZED (
             SELECT expected.block_number, block.block_hash, block.block_number IS NULL AS missing
               FROM expected LEFT JOIN robinhood_chain_blocks block
                 ON block.chain=$1 AND block.canonical=TRUE
                AND block.block_number=expected.block_number
           ), transactions AS MATERIALIZED (
             SELECT transaction.nonce FROM coverage
               JOIN robinhood_chain_transactions transaction
                 ON transaction.chain=$1 AND transaction.block_hash=coverage.block_hash
           )
           SELECT (SELECT COUNT(*) FROM expected) AS expected_blocks,
                  COUNT(*) FILTER (WHERE NOT missing) AS canonical_blocks,
                  COUNT(*) FILTER (WHERE missing) AS missing_blocks,
                  MIN(block_number) FILTER (WHERE missing) AS first_missing_block,
                  (SELECT COUNT(*) FROM transactions) AS transactions,
                  (SELECT COUNT(*) FROM transactions WHERE nonce IS NULL)
                    AS transactions_missing_nonce
             FROM coverage`,
          [CHAIN, text(frontiers.contextFirst), text(frontiers.contextLast)]
        );
        context = {
          ...result.rows[0], checked_first_block: text(frontiers.contextFirst),
          checked_last_block: text(frontiers.contextLast),
        };
      }
      const leaseResult = await client.query(
        `SELECT lease_key, lease_until > NOW() AS active, heartbeat_at, metadata
           FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
        [Object.values(LEASE_KEYS)]
      );
      await client.query('ROLLBACK');
      return evaluate({
        state, context, leases: leaseResult.rows, confirmations, phase: auditPhase,
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_CONFIRMATIONS, LEASE_KEYS, MAX_CONTEXT_BLOCKS, PHASES,
  createRobinhoodCanonicalSignedOriginAudit, evaluate,
};
