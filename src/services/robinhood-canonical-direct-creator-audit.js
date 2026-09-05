'use strict';

const db = require('../models/db');
const { FACTORIES } = require('./robinhood-launchpad-creator-adapter');

const CHAIN = 'robinhood';
const DEFAULT_CONFIRMATIONS = 2;
const MAX_CAPTURE_LAG = 2n;
const MAX_CONTEXT_BLOCKS = 200n;
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  creator: 'robinhood-direct-creator-live-worker',
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
    last_error: telemetry.lastError || null,
  });
}

function calculateFrontiers(row, confirmations) {
  const captureNext = quantity(row.capture_next_block);
  const captureCheckpoint = quantity(row.capture_checkpoint_block);
  const captureHead = quantity(row.capture_node_head);
  const journalStart = quantity(row.journal_start_block);
  const creatorNext = quantity(row.creator_next_block);
  const creatorCheckpoint = quantity(row.creator_checkpoint_block);
  const confirmedHead = captureHead == null ? null
    : captureHead >= BigInt(confirmations) ? captureHead - BigInt(confirmations) : 0n;
  const canonicalSafeHead = confirmedHead == null || captureCheckpoint == null
    ? null : confirmedHead < captureCheckpoint ? confirmedHead : captureCheckpoint;
  const contextFirst = creatorNext == null || journalStart == null
    ? null : creatorNext > journalStart ? creatorNext : journalStart;
  const contextLast = contextFirst == null || canonicalSafeHead == null
    ? null : [contextFirst + MAX_CONTEXT_BLOCKS - 1n, canonicalSafeHead]
      .reduce((minimum, value) => (value < minimum ? value : minimum));
  return {
    captureNext, captureCheckpoint, captureHead,
    captureLag: distance(captureNext, captureHead),
    journalStart, creatorNext, creatorCheckpoint, canonicalSafeHead,
    preJournalBlocks: distance(creatorNext, journalStart == null ? null : journalStart - 1n),
    creatorLag: distance(creatorNext, canonicalSafeHead), contextFirst, contextLast,
  };
}

function migrationBlockers(row, context, frontiers, leases) {
  const blockers = [];
  const add = (condition, code, detail = null) => {
    if (condition) blockers.push(detail == null ? { code } : { code, detail });
  };
  const checkpointFields = [
    row.creator_checkpoint_block,
    row.creator_checkpoint_hash,
    row.creator_checkpoint_timestamp,
  ];
  const checkpointComplete = checkpointFields.every((value) => value != null);
  const checkpointSequence = checkpointComplete && frontiers.creatorNext != null
    && frontiers.creatorCheckpoint + 1n === frontiers.creatorNext;
  const checkpointCanonical = checkpointSequence
    && row.canonical_creator_checkpoint_hash === row.creator_checkpoint_hash;

  add(frontiers.captureNext == null, 'capture_cursor_missing');
  add(frontiers.captureNext != null && frontiers.captureHead == null, 'capture_head_missing');
  add(frontiers.captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(frontiers.captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(!leases.capture.active, 'canonical_capture_inactive');
  add(frontiers.journalStart == null, 'canonical_journal_empty');
  add(frontiers.creatorNext == null, 'direct_creator_cursor_missing');
  add(frontiers.creatorNext != null && !checkpointSequence,
    'direct_creator_checkpoint_inconsistent');
  add(checkpointSequence && !checkpointCanonical, 'direct_creator_checkpoint_not_canonical');
  add(frontiers.preJournalBlocks > 0n, 'direct_creator_before_canonical_journal',
    text(frontiers.preJournalBlocks));
  add(frontiers.preJournalBlocks > 0n && !leases.creator.active,
    'direct_creator_catchup_inactive');
  add(frontiers.creatorCheckpoint != null && frontiers.canonicalSafeHead != null
    && frontiers.creatorCheckpoint > frontiers.canonicalSafeHead,
  'direct_creator_ahead_of_canonical_capture', {
    creator: text(frontiers.creatorCheckpoint), capture: text(frontiers.canonicalSafeHead),
  });
  add(Number(context.missing_blocks || 0) > 0, 'canonical_block_context_missing', {
    count: Number(context.missing_blocks),
    first_block: text(context.first_missing_block),
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
    direct_creator: {
      next_block: text(frontiers.creatorNext),
      checkpoint_block: text(frontiers.creatorCheckpoint),
      safe_head: text(row.creator_safe_head),
      updated_at: row.creator_updated_at || null,
      lag_to_canonical_safe_head: text(frontiers.creatorLag),
    },
    handoff: {
      journal_start_block: text(frontiers.journalStart),
      pre_journal_blocks_remaining: text(frontiers.preJournalBlocks),
      checkpoint_canonical: row.canonical_creator_checkpoint_hash != null
        && row.canonical_creator_checkpoint_hash === row.creator_checkpoint_hash,
    },
    context: {
      first_block: text(context.checked_first_block ?? frontiers.contextFirst),
      last_block: text(context.checked_last_block ?? frontiers.contextLast),
      max_blocks: text(MAX_CONTEXT_BLOCKS),
      expected_blocks: Number(context.expected_blocks || 0),
      canonical_blocks: Number(context.canonical_blocks || 0),
      direct_deployments: Number(context.direct_deployments || 0),
      launchpad_events: Number(context.launchpad_events || 0),
      missing_blocks: Number(context.missing_blocks || 0),
    },
    contract: {
      external_creations: 'covered', launchpad_events: 'covered',
      internal_create_create2: 'requires_trace_source',
    },
    leases: {
      capture: leaseSummary(leases.capture), creator: leaseSummary(leases.creator),
    },
  });
}

function createRobinhoodCanonicalDirectCreatorAudit(options = {}) {
  const database = options.database || db;
  const confirmations = options.confirmations
    ?? process.env.ROBINHOOD_CONFIRMATIONS
    ?? DEFAULT_CONFIRMATIONS;

  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stateResult = await client.query(
        `SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                creator.next_block AS creator_next_block,
                creator.safe_head AS creator_safe_head,
                creator.checkpoint_block AS creator_checkpoint_block,
                creator.checkpoint_hash AS creator_checkpoint_hash,
                creator.checkpoint_timestamp AS creator_checkpoint_timestamp,
                creator.updated_at AS creator_updated_at,
                journal.block_number AS journal_start_block,
                canonical_creator.block_hash AS canonical_creator_checkpoint_hash
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
           LEFT JOIN robinhood_direct_creator_cursors creator
             ON creator.chain=$1 AND creator.stream='live'
           LEFT JOIN LATERAL (
             SELECT block_number FROM robinhood_chain_blocks
              WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1
           ) journal ON TRUE
           LEFT JOIN robinhood_chain_blocks canonical_creator
             ON canonical_creator.chain=$1 AND canonical_creator.canonical=TRUE
            AND canonical_creator.block_number=creator.checkpoint_block`,
        [CHAIN]
      );
      const state = stateResult.rows[0] || {};
      const frontiers = calculateFrontiers(state, confirmations);
      let context = {};
      if (frontiers.contextFirst != null && frontiers.contextLast != null
          && frontiers.contextFirst <= frontiers.contextLast) {
        const factories = [...FACTORIES.keys()];
        const topics = [...new Set([...FACTORIES.values()].map(({ topic }) => topic))];
        const contextResult = await client.query(
          `WITH expected AS MATERIALIZED (
             SELECT generate_series($2::bigint, $3::bigint) AS block_number
           ), coverage AS MATERIALIZED (
             SELECT expected.block_number, block.block_number IS NULL AS missing
               FROM expected
               LEFT JOIN robinhood_chain_blocks block
                 ON block.chain=$1 AND block.canonical=TRUE
                AND block.block_number=expected.block_number
           )
           SELECT COUNT(*) AS expected_blocks,
                  COUNT(*) FILTER (WHERE NOT missing) AS canonical_blocks,
                  COUNT(*) FILTER (WHERE missing) AS missing_blocks,
                  MIN(block_number) FILTER (WHERE missing) AS first_missing_block,
                  (SELECT COUNT(*) FROM robinhood_chain_transactions transaction
                    JOIN robinhood_chain_blocks block
                      ON block.chain=transaction.chain AND block.block_hash=transaction.block_hash
                   WHERE block.chain=$1 AND block.canonical=TRUE
                     AND block.block_number BETWEEN $2::bigint AND $3::bigint
                     AND transaction.to_address IS NULL
                     AND transaction.contract_address IS NOT NULL) AS direct_deployments,
                  (SELECT COUNT(*) FROM robinhood_chain_events event
                    JOIN robinhood_chain_blocks block
                      ON block.chain=event.chain AND block.block_hash=event.block_hash
                   WHERE event.chain=$1 AND block.canonical=TRUE
                     AND event.block_number BETWEEN $2::bigint AND $3::bigint
                     AND event.address=ANY($4::varchar[]) AND event.topic0=ANY($5::varchar[]))
                    AS launchpad_events
             FROM coverage`,
          [CHAIN, text(frontiers.contextFirst), text(frontiers.contextLast), factories, topics]
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
  createRobinhoodCanonicalDirectCreatorAudit, evaluate,
};
