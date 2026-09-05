'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const DEFAULT_CONFIRMATIONS = 12;
const MAX_CAPTURE_LAG = 2n;
const MAX_CONTEXT_BLOCKS = 200n;
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  wallet: 'robinhood-wallet-swap-live-worker',
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
    halted: telemetry.halted === true,
    lag_blocks: text(telemetry.lagBlocks),
    last_error: telemetry.lastError || null,
  });
}

function calculateFrontiers(row, confirmations) {
  const captureNext = quantity(row.capture_next_block);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const captureHead = quantity(row.capture_node_head);
  const journalStart = quantity(row.journal_start_block);
  const processingNext = quantity(row.processing_next_block);
  const walletNext = quantity(row.wallet_next_block);
  const walletCheckpoint = quantity(row.wallet_checkpoint_block);
  const confirmedHead = captureHead == null ? null
    : captureHead >= BigInt(confirmations) ? captureHead - BigInt(confirmations) : 0n;
  const canonicalSafeHead = confirmedHead == null || captureCheckpoint == null
    ? null : confirmedHead < captureCheckpoint ? confirmedHead : captureCheckpoint;
  const processingThrough = processingNext == null || processingNext === 0n
    ? null : processingNext - 1n;
  const processableThrough = canonicalSafeHead == null || processingThrough == null
    ? null : canonicalSafeHead < processingThrough ? canonicalSafeHead : processingThrough;
  const contextFirst = walletNext == null || journalStart == null
    ? null : walletNext > journalStart ? walletNext : journalStart;
  const contextLast = contextFirst == null || processableThrough == null
    ? null : [contextFirst + MAX_CONTEXT_BLOCKS - 1n, processableThrough]
      .reduce((minimum, value) => (value < minimum ? value : minimum));
  return {
    captureNext, captureCheckpoint, captureHead,
    captureLag: distance(captureNext, captureHead),
    journalStart, processingNext, processingThrough, canonicalSafeHead,
    processableThrough, walletNext, walletCheckpoint,
    preJournalBlocks: distance(walletNext, journalStart == null ? null : journalStart - 1n),
    walletLag: distance(walletNext, processableThrough), contextFirst, contextLast,
  };
}

function migrationBlockers(row, context, frontiers, leases) {
  const blockers = [];
  const add = (condition, code, detail = null) => {
    if (condition) blockers.push(detail == null ? { code } : { code, detail });
  };
  const checkpointFields = [
    row.wallet_checkpoint_block,
    row.wallet_checkpoint_hash,
    row.wallet_checkpoint_timestamp,
  ];
  const checkpointComplete = checkpointFields.every((value) => value != null);
  const checkpointSequence = checkpointComplete && frontiers.walletNext != null
    && frontiers.walletCheckpoint < frontiers.walletNext;
  const checkpointCanonical = checkpointSequence
    && row.canonical_wallet_checkpoint_hash === row.wallet_checkpoint_hash;

  add(frontiers.captureNext == null, 'capture_cursor_missing');
  add(frontiers.captureNext != null && frontiers.captureHead == null, 'capture_head_missing');
  add(frontiers.captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(frontiers.captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(!leases.capture.active, 'canonical_capture_inactive');
  add(frontiers.journalStart == null, 'canonical_journal_empty');
  add(frontiers.processingNext == null, 'processing_frontier_missing');
  add(frontiers.walletNext == null, 'wallet_live_cursor_missing');
  add(frontiers.walletNext != null && row.wallet_lifecycle_state !== 'running',
    'wallet_live_not_running', row.wallet_lifecycle_state);
  add(frontiers.walletNext != null && !checkpointSequence,
    'wallet_live_checkpoint_inconsistent');
  add(checkpointSequence && !checkpointCanonical, 'wallet_checkpoint_not_canonical');
  add(frontiers.preJournalBlocks > 0n, 'wallet_before_canonical_journal',
    text(frontiers.preJournalBlocks));
  add(frontiers.preJournalBlocks > 0n && !leases.wallet.active, 'wallet_catchup_inactive');
  add(frontiers.walletCheckpoint != null && frontiers.processableThrough != null
    && frontiers.walletCheckpoint > frontiers.processableThrough,
  'wallet_ahead_of_processable_frontier', {
    wallet: text(frontiers.walletCheckpoint),
    processable: text(frontiers.processableThrough),
  });
  add(Number(context.missing_context || 0) > 0, 'accepted_transaction_context_missing', {
    count: Number(context.missing_context),
    first_block: text(context.first_missing_block),
    transaction_hash: context.first_missing_transaction_hash || null,
  });
  return blockers;
}

function evaluate(input = {}) {
  const row = input.state || {};
  const context = input.context || {};
  const confirmations = Number(input.confirmations ?? DEFAULT_CONFIRMATIONS);
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 1000) {
    throw new Error('confirmations must be between 0 and 1000');
  }
  const frontiers = calculateFrontiers(row, confirmations);
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, activeLease(input.leases || [], key)]
  )));
  const blockers = migrationBlockers(row, context, frontiers, leases);
  return Object.freeze({
    mode: 'read-only', ready: blockers.length === 0, blockers,
    capture: {
      next_block: text(frontiers.captureNext),
      checkpoint_block: text(frontiers.captureCheckpoint),
      node_head: text(frontiers.captureHead), lag_blocks: text(frontiers.captureLag),
      confirmations, safe_head: text(frontiers.canonicalSafeHead),
    },
    processing: {
      next_block: text(frontiers.processingNext),
      through_block: text(frontiers.processingThrough),
      processable_through_block: text(frontiers.processableThrough),
    },
    wallet: {
      next_block: text(frontiers.walletNext),
      checkpoint_block: text(frontiers.walletCheckpoint),
      safe_head: text(row.wallet_safe_head),
      lifecycle_state: row.wallet_lifecycle_state || null,
      updated_at: row.wallet_updated_at || null,
      lag_to_processable_blocks: text(frontiers.walletLag),
    },
    handoff: {
      journal_start_block: text(frontiers.journalStart),
      pre_journal_blocks_remaining: text(frontiers.preJournalBlocks),
      checkpoint_canonical: row.canonical_wallet_checkpoint_hash != null
        && row.canonical_wallet_checkpoint_hash === row.wallet_checkpoint_hash,
    },
    transaction_context: {
      first_block: text(context.checked_first_block ?? frontiers.contextFirst),
      last_block: text(context.checked_last_block ?? frontiers.contextLast),
      max_blocks: text(MAX_CONTEXT_BLOCKS),
      accepted_observations: Number(context.accepted_observations || 0),
      missing: Number(context.missing_context || 0),
    },
    leases: {
      capture: leaseSummary(leases.capture), wallet: leaseSummary(leases.wallet),
    },
  });
}

function createRobinhoodCanonicalWalletSwapAudit(options = {}) {
  const database = options.database || db;
  const confirmations = options.confirmations
    ?? process.env.ROBINHOOD_WALLET_SWAP_LIVE_REORG_DEPTH
    ?? DEFAULT_CONFIRMATIONS;

  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stateResult = await client.query(
        `WITH leased AS MATERIALIZED (
           SELECT block_number, transaction_index, log_index
             FROM robinhood_head_captures
            WHERE chain=$1 AND stream='market' AND processing_status='leased'
         ), active AS (
           (SELECT block_number, transaction_index, log_index
              FROM robinhood_head_captures
             WHERE chain=$1 AND stream='market' AND processing_status='pending'
             ORDER BY block_number, transaction_index, log_index LIMIT 1)
           UNION ALL
           (SELECT block_number, transaction_index, log_index FROM leased
             ORDER BY block_number, transaction_index, log_index LIMIT 1)
         ), pending AS MATERIALIZED (
           SELECT block_number FROM active
            ORDER BY block_number, transaction_index, log_index LIMIT 1
         )
         SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                wallet.next_block AS wallet_next_block,
                wallet.safe_head AS wallet_safe_head,
                wallet.checkpoint_block AS wallet_checkpoint_block,
                wallet.checkpoint_hash AS wallet_checkpoint_hash,
                wallet.checkpoint_timestamp AS wallet_checkpoint_timestamp,
                wallet.lifecycle_state AS wallet_lifecycle_state,
                wallet.updated_at AS wallet_updated_at,
                CASE WHEN frontier.block_number IS NULL THEN NULL
                     WHEN pending.block_number IS NULL THEN frontier.block_number + 1
                     ELSE pending.block_number END
                  AS processing_next_block,
                journal.block_number AS journal_start_block,
                canonical_wallet.block_hash AS canonical_wallet_checkpoint_hash
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN robinhood_wallet_swap_cursors wallet
             ON wallet.chain=$1 AND wallet.stream='live'
           LEFT JOIN pending ON TRUE
           LEFT JOIN LATERAL (
             SELECT observation.block_number
               FROM robinhood_market_observations observation
              WHERE observation.chain=$1 AND observation.status='accepted'
                AND observation.block_number < COALESCE(
                  pending.block_number, 9223372036854775807::bigint)
              ORDER BY observation.block_number DESC, observation.log_index DESC LIMIT 1
           ) frontier ON TRUE
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1
           ) journal ON TRUE
           LEFT JOIN robinhood_chain_blocks canonical_wallet
             ON canonical_wallet.chain=$1 AND canonical_wallet.canonical=TRUE
            AND canonical_wallet.block_number=wallet.checkpoint_block`,
        [CHAIN]
      );
      const state = stateResult.rows[0] || {};
      const frontiers = calculateFrontiers(state, confirmations);
      let context = {};
      if (frontiers.contextFirst != null && frontiers.contextLast != null
          && frontiers.contextFirst <= frontiers.contextLast) {
        const contextResult = await client.query(
          `WITH candidates AS MATERIALIZED (
             SELECT observation.block_number, observation.transaction_hash
               FROM robinhood_market_observations observation
              WHERE observation.chain=$1 AND observation.status='accepted'
                AND observation.block_number BETWEEN $2::bigint AND $3::bigint
           ), checked AS MATERIALIZED (
             SELECT candidate.*, transaction.transaction_hash IS NULL AS missing
               FROM candidates candidate
               LEFT JOIN robinhood_chain_blocks block
                 ON block.chain=$1 AND block.canonical=TRUE
                AND block.block_number=candidate.block_number
               LEFT JOIN robinhood_chain_transactions transaction
                 ON transaction.chain=$1 AND transaction.block_hash=block.block_hash
                AND transaction.transaction_hash=candidate.transaction_hash
           )
           SELECT COUNT(*) AS accepted_observations,
                  COUNT(*) FILTER (WHERE missing) AS missing_context,
                  (ARRAY_AGG(block_number ORDER BY block_number)
                    FILTER (WHERE missing))[1] AS first_missing_block,
                  (ARRAY_AGG(transaction_hash ORDER BY block_number)
                    FILTER (WHERE missing))[1] AS first_missing_transaction_hash
             FROM checked`,
          [CHAIN, text(frontiers.contextFirst), text(frontiers.contextLast)]
        );
        context = {
          ...contextResult.rows[0],
          checked_first_block: text(frontiers.contextFirst),
          checked_last_block: text(frontiers.contextLast),
        };
      }
      const leaseResult = await client.query(
        `SELECT lease_key, lease_until > NOW() AS active, heartbeat_at, metadata
           FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
        [Object.values(LEASE_KEYS)]
      );
      await client.query('ROLLBACK');
      return evaluate({ state, context, leases: leaseResult.rows, confirmations });
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
  DEFAULT_CONFIRMATIONS, LEASE_KEYS, MAX_CONTEXT_BLOCKS,
  createRobinhoodCanonicalWalletSwapAudit, evaluate,
};
