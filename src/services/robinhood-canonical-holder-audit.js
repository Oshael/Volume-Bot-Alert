'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const DEFAULT_CONFIRMATIONS = 12;
const MAX_CAPTURE_LAG = 2n;
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  holder: 'robinhood-holder-live-worker',
  apply: 'robinhood-holder-live-apply-worker',
});

function quantity(value) {
  return value == null ? null : BigInt(value);
}

function text(value) {
  return value == null ? null : String(value);
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
    active: Boolean(lease.active),
    heartbeat_at: lease.heartbeat_at || null,
    running: telemetry.running === true,
    source_mode: telemetry.sourceMode || null,
    last_error: telemetry.lastError || null,
  });
}

function calculateFrontiers(row, confirmations) {
  const captureNext = quantity(row.capture_next_block);
  const captureHead = quantity(row.capture_node_head);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const journalStart = quantity(row.journal_start_block);
  const holderNext = quantity(row.holder_next_block);
  const holderCheckpoint = quantity(row.holder_checkpoint_block);
  const confirmedHead = captureHead == null ? null
    : captureHead >= BigInt(confirmations) ? captureHead - BigInt(confirmations) : 0n;
  const canonicalSafeHead = confirmedHead == null || captureCheckpoint == null
    ? null : confirmedHead < captureCheckpoint ? confirmedHead : captureCheckpoint;
  const captureLag = captureNext == null || captureHead == null
    ? null : distance(captureNext, captureHead);
  const preJournalLast = journalStart == null ? null : journalStart - 1n;
  return {
    captureNext, captureHead, captureCheckpoint, captureLag, journalStart,
    holderNext, holderCheckpoint, canonicalSafeHead,
    preJournalBlocks: distance(holderNext, preJournalLast),
    canonicalBacklog: distance(holderNext, canonicalSafeHead),
  };
}

function migrationBlockers(row, frontiers, leases) {
  const blockers = [];
  const add = (condition, code, detail = null) => {
    if (condition) blockers.push(detail == null ? { code } : { code, detail });
  };
  const {
    captureNext, captureHead, captureCheckpoint, captureLag, journalStart,
    holderNext, holderCheckpoint, preJournalBlocks,
  } = frontiers;
  const checkpointPair = holderCheckpoint != null && row.holder_checkpoint_hash != null;
  const checkpointSequence = checkpointPair && holderNext != null
    && holderCheckpoint + 1n === holderNext;
  const checkpointCanonical = checkpointSequence
    && row.canonical_holder_checkpoint_hash === row.holder_checkpoint_hash;

  add(captureNext == null, 'capture_cursor_missing');
  add(captureNext != null && captureHead == null, 'capture_head_missing');
  add(captureLag != null && captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(!leases.capture.active, 'canonical_capture_inactive');
  add(journalStart == null, 'canonical_journal_empty');
  add(holderNext == null, 'holder_cursor_missing');
  add(holderNext != null && !checkpointSequence, 'holder_cursor_checkpoint_inconsistent');
  add(checkpointSequence && !checkpointCanonical, 'holder_checkpoint_not_canonical');
  add(row.holder_journal_floor_block == null, 'holder_journal_floor_uninitialized');
  add(row.holder_buffer_floor_block == null, 'holder_buffer_floor_uninitialized');
  add(preJournalBlocks > 0n, 'holder_before_canonical_journal', text(preJournalBlocks));
  add(preJournalBlocks > 0n && !leases.holder.active, 'holder_catchup_inactive');
  add(holderCheckpoint != null && captureCheckpoint != null
    && holderCheckpoint > captureCheckpoint, 'holder_ahead_of_canonical_capture', {
    holder: text(holderCheckpoint), capture: text(captureCheckpoint),
  });
  add(Number(row.invalid_live_frontiers || 0) > 0, 'holder_live_frontier_invalid',
    Number(row.invalid_live_frontiers));
  return blockers;
}

function evaluate(input = {}) {
  const row = input.state || {};
  const confirmations = Number(input.confirmations ?? DEFAULT_CONFIRMATIONS);
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 1000) {
    throw new Error('confirmations must be between 0 and 1000');
  }
  const frontiers = calculateFrontiers(row, confirmations);
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, activeLease(input.leases || [], key)]
  )));
  const blockers = migrationBlockers(row, frontiers, leases);
  return Object.freeze({
    mode: 'read-only', ready: blockers.length === 0, blockers,
    capture: {
      next_block: text(frontiers.captureNext),
      checkpoint_block: text(frontiers.captureCheckpoint),
      node_head: text(frontiers.captureHead), lag_blocks: text(frontiers.captureLag),
      confirmations, safe_head: text(frontiers.canonicalSafeHead),
    },
    holder: {
      next_block: text(frontiers.holderNext),
      checkpoint_block: text(frontiers.holderCheckpoint),
      safe_head: text(row.holder_safe_head),
      journal_floor_block: text(row.holder_journal_floor_block),
      buffer_floor_block: text(row.holder_buffer_floor_block),
      updated_at: row.holder_updated_at || null,
      lag_to_canonical_safe_head: text(frontiers.canonicalBacklog),
    },
    handoff: {
      journal_start_block: text(frontiers.journalStart),
      pre_journal_blocks_remaining: text(frontiers.preJournalBlocks),
      checkpoint_canonical: row.canonical_holder_checkpoint_hash != null
        && row.canonical_holder_checkpoint_hash === row.holder_checkpoint_hash,
    },
    tokens: {
      total: Number(row.total_tokens || 0), pending: Number(row.pending_tokens || 0),
      backfilling: Number(row.backfilling_tokens || 0),
      shadow: Number(row.shadow_tokens || 0), live: Number(row.live_tokens || 0),
      drifted: Number(row.drifted_tokens || 0),
      resyncing: Number(row.resyncing_tokens || 0),
      invalid_live_frontiers: Number(row.invalid_live_frontiers || 0),
    },
    apply: {
      queued_tokens: Number(row.queued_tokens || 0),
      oldest_pending_block: text(row.oldest_pending_block),
      newest_pending_block: text(row.newest_pending_block),
    },
    leases: Object.freeze({
      capture: leaseSummary(leases.capture), holder: leaseSummary(leases.holder),
      apply: leaseSummary(leases.apply),
    }),
  });
}

function createRobinhoodCanonicalHolderAudit(options = {}) {
  const database = options.database || db;
  const confirmations = options.confirmations
    ?? process.env.ROBINHOOD_HOLDER_LIVE_CONFIRMATIONS
    ?? DEFAULT_CONFIRMATIONS;

  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = await client.query(
        `WITH token_counts AS MATERIALIZED (
           SELECT COUNT(*) AS total_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='pending') AS pending_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='backfilling') AS backfilling_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='shadow') AS shadow_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='live') AS live_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='drifted') AS drifted_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='resyncing') AS resyncing_tokens,
                  COUNT(*) FILTER (WHERE ledger_status='live' AND
                    (live_through_block IS NULL OR live_through_hash IS NULL))
                    AS invalid_live_frontiers
             FROM robinhood_holder_token_states WHERE chain=$1
         ), hot_queue AS MATERIALIZED (
           SELECT COUNT(*) AS queued_tokens, MIN(first_pending_block) AS oldest_pending_block,
                  MAX(last_pending_block) AS newest_pending_block
             FROM robinhood_holder_hot_queue WHERE chain=$1
         )
         SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                holder.next_block AS holder_next_block,
                holder.safe_head AS holder_safe_head,
                holder.checkpoint_block AS holder_checkpoint_block,
                holder.checkpoint_hash AS holder_checkpoint_hash,
                holder.journal_floor_block AS holder_journal_floor_block,
                holder.buffer_floor_block AS holder_buffer_floor_block,
                holder.updated_at AS holder_updated_at,
                (SELECT block_number FROM robinhood_chain_blocks
                  WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1)
                  AS journal_start_block,
                canonical_holder.block_hash AS canonical_holder_checkpoint_hash,
                token_counts.*, hot_queue.*
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN robinhood_holder_cursors holder
             ON holder.chain=$1 AND holder.stream='live'
           LEFT JOIN robinhood_chain_blocks canonical_holder
             ON canonical_holder.chain=$1 AND canonical_holder.canonical=TRUE
            AND canonical_holder.block_number=holder.checkpoint_block
           CROSS JOIN token_counts CROSS JOIN hot_queue`,
        [CHAIN]
      );
      const leaseResult = await client.query(
        `SELECT lease_key, lease_until > NOW() AS active, heartbeat_at, metadata
           FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
        [Object.values(LEASE_KEYS)]
      );
      await client.query('ROLLBACK');
      return evaluate({
        state: state.rows[0] || {}, leases: leaseResult.rows, confirmations,
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_CONFIRMATIONS,
  LEASE_KEYS,
  createRobinhoodCanonicalHolderAudit,
  evaluate,
};
