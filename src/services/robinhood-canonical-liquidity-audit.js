'use strict';

const db = require('../models/db');
const {
  LIQUIDITY_EVENT_TOPICS,
} = require('./robinhood-pool-liquidity-events');

const CHAIN = 'robinhood';
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  liquidity: 'robinhood-pool-liquidity-worker',
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
  return Object.freeze({
    active: Boolean(lease.active),
    heartbeat_at: lease.heartbeat_at || null,
    last_error: lease.metadata?.lastError || null,
    running: lease.metadata?.running === true,
  });
}

function calculateFrontiers(row) {
  const captureNext = quantity(row.capture_next_block);
  const captureHead = quantity(row.capture_node_head);
  const journalStart = quantity(row.journal_start_block);
  const journalThrough = quantity(row.capture_checkpoint_block);
  const liquidityNext = quantity(row.liquidity_next_block);
  const processingCheckpoint = quantity(row.processing_checkpoint_block);
  const processingPending = quantity(row.processing_pending_block);
  const processingFrontier = processingCheckpoint == null ? null
    : processingPending == null ? processingCheckpoint : processingPending - 1n;
  const target = processingFrontier;
  const captureLag = captureNext == null || captureHead == null
    ? null : captureHead >= captureNext ? captureHead - captureNext + 1n : 0n;
  const preJournalLast = journalStart == null || target == null
    ? null : target < journalStart ? target : journalStart - 1n;
  const preJournalBlocks = distance(liquidityNext, preJournalLast);
  const journalPendingFirst = liquidityNext == null || journalStart == null
    ? null : liquidityNext > journalStart ? liquidityNext : journalStart;
  const journalPendingLast = target == null || journalThrough == null
    ? null : target < journalThrough ? target : journalThrough;
  const journalBlocks = distance(journalPendingFirst, journalPendingLast);
  const uncapturedBlocks = target == null || journalThrough == null || target <= journalThrough
    ? 0n : target - journalThrough;
  const liveLag = distance(liquidityNext, target);
  return {
    captureNext, captureHead, captureLag, journalStart, journalThrough, liquidityNext,
    processingFrontier, preJournalBlocks, journalBlocks, uncapturedBlocks, liveLag,
  };
}

function migrationBlockers(frontiers, leases) {
  const {
    captureNext, captureHead, captureLag, journalStart, liquidityNext,
    processingFrontier, preJournalBlocks, uncapturedBlocks,
  } = frontiers;
  const blockers = [];
  const add = (condition, code, detail) => {
    if (condition) blockers.push(detail == null ? { code } : { code, detail });
  };
  add(captureNext == null, 'capture_cursor_missing');
  add(captureNext != null && captureHead == null, 'capture_head_missing');
  add(captureLag != null && captureLag > 2n, 'capture_lag_exceeded', text(captureLag));
  add(!leases.capture.active, 'canonical_capture_inactive');
  add(journalStart == null, 'canonical_journal_empty');
  add(liquidityNext == null, 'liquidity_cursor_missing');
  add(processingFrontier == null, 'processing_frontier_missing');
  add(preJournalBlocks > 0n, 'liquidity_before_journal', text(preJournalBlocks));
  add(preJournalBlocks > 0n && !leases.liquidity.active, 'liquidity_catchup_inactive');
  add(uncapturedBlocks > 0n, 'journal_behind_processing', text(uncapturedBlocks));
  return blockers;
}

function evaluate(input = {}) {
  const row = input.state || {};
  const frontiers = calculateFrontiers(row);
  const {
    captureNext, captureHead, captureLag, journalStart, journalThrough, liquidityNext,
    processingFrontier, preJournalBlocks, journalBlocks, uncapturedBlocks, liveLag,
  } = frontiers;
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, activeLease(input.leases || [], key)]
  )));
  const blockers = migrationBlockers(frontiers, leases);

  const topics = LIQUIDITY_EVENT_TOPICS.map((topic0) => {
    const evidence = (input.topics || []).find((entry) => entry.topic0 === topic0) || {};
    return Object.freeze({
      topic0,
      first_block: text(evidence.first_block),
      last_block: text(evidence.last_block),
    });
  });
  return Object.freeze({
    mode: 'read-only', ready: blockers.length === 0, blockers,
    capture: {
      next_block: text(captureNext), node_head: text(captureHead),
      lag_blocks: text(captureLag),
    },
    liquidity: {
      coverage_start_block: text(row.liquidity_coverage_start_block),
      next_block: text(liquidityNext), checkpoint_block: text(row.liquidity_checkpoint_block),
      safe_head: text(row.liquidity_safe_head), updated_at: row.liquidity_updated_at || null,
      lag_to_processing_blocks: text(liveLag),
    },
    handoff: {
      journal_start_block: text(journalStart),
      journal_through_block: text(journalThrough),
      processing_frontier: text(processingFrontier),
      pre_journal_blocks_remaining: text(preJournalBlocks),
      journal_blocks_available: text(journalBlocks),
      processing_blocks_not_captured: text(uncapturedBlocks),
    },
    source: {
      configured_topics: LIQUIDITY_EVENT_TOPICS.length,
      observed_topics: topics.filter((entry) => entry.last_block != null).length,
      topics,
    },
    leases: {
      capture: leaseSummary(leases.capture),
      liquidity: leaseSummary(leases.liquidity),
    },
  });
}

function createRobinhoodCanonicalLiquidityAudit(options = {}) {
  const database = options.database || db;

  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = await client.query(
        `WITH pending AS MATERIALIZED (
           SELECT outbox.block_number
             FROM robinhood_chain_domain_outbox outbox
            WHERE outbox.chain = $1 AND outbox.status <> 'complete'
            ORDER BY outbox.block_number, outbox.status, outbox.domain,
                     outbox.transaction_index, outbox.log_index LIMIT 1
         )
         SELECT capture.next_block AS capture_next_block,
                capture.checkpoint_block AS capture_checkpoint_block,
                capture.node_head AS capture_node_head,
                liquidity.coverage_start_block AS liquidity_coverage_start_block,
                liquidity.next_block AS liquidity_next_block,
                liquidity.checkpoint_block AS liquidity_checkpoint_block,
                liquidity.safe_head AS liquidity_safe_head,
                liquidity.updated_at AS liquidity_updated_at,
                capture.checkpoint_block AS processing_checkpoint_block,
                pending.block_number AS processing_pending_block,
                (SELECT block_number
                   FROM robinhood_chain_blocks
                  WHERE chain = $1 AND canonical = TRUE
                  ORDER BY block_number LIMIT 1) AS journal_start_block
           FROM (VALUES (1)) AS anchor(value)
           LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain = $1
           LEFT JOIN robinhood_pool_liquidity_event_cursors liquidity ON liquidity.chain = $1
           LEFT JOIN pending ON TRUE`,
        [CHAIN]
      );
      const topicEvidence = await client.query(
        `SELECT requested.topic0, first_seen.block_number AS first_block,
                last_seen.block_number AS last_block
           FROM unnest($2::text[]) WITH ORDINALITY AS requested(topic0, position)
           LEFT JOIN LATERAL (
             SELECT event.block_number
               FROM robinhood_chain_events event
              WHERE event.chain = $1 AND event.topic0 = requested.topic0
              ORDER BY event.block_number ASC LIMIT 1
           ) first_seen ON TRUE
           LEFT JOIN LATERAL (
             SELECT event.block_number
               FROM robinhood_chain_events event
              WHERE event.chain = $1 AND event.topic0 = requested.topic0
              ORDER BY event.block_number DESC LIMIT 1
           ) last_seen ON TRUE
          ORDER BY requested.position`,
        [CHAIN, LIQUIDITY_EVENT_TOPICS]
      );
      const leaseResult = await client.query(
        `SELECT lease_key, lease_until > NOW() AS active, heartbeat_at, metadata
           FROM worker_leases
          WHERE lease_key = ANY($1::varchar[])`,
        [Object.values(LEASE_KEYS)]
      );
      await client.query('ROLLBACK');
      return evaluate({
        state: state.rows[0] || {}, topics: topicEvidence.rows, leases: leaseResult.rows,
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
  LEASE_KEYS, createRobinhoodCanonicalLiquidityAudit, evaluate,
};
