'use strict';

const db = require('../models/db');
const { RULE_VERSION } = require('./robinhood-fresh-wallet-rule');

const CHAIN = 'robinhood';
const MAX_CAPTURE_LAG = 2n;
const SAMPLE_LIMIT = 100;
const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  firstBuy: 'robinhood-first-buy-live-worker',
  signedOrigin: 'robinhood-signed-origin-live-worker',
  fresh: 'robinhood-fresh-wallet-live-worker',
});

function quantity(value) { return value == null ? null : BigInt(value); }
function count(value) { return Number(value ?? 0); }
function text(value) { return value == null ? null : String(value); }
function timestamp(value) {
  return value == null ? null : value.toISOString?.() || String(value);
}
function distance(first, last) {
  return first == null || last == null || last < first ? 0n : last - first + 1n;
}
function leaseSummary(rows, key) {
  const lease = rows.find((row) => row.lease_key === key) || {};
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

function validateFoundation(blockers, values) {
  add(blockers, values.captureNext == null, 'capture_cursor_missing');
  add(blockers, values.captureNext != null && values.captureHead == null,
    'capture_head_missing');
  add(blockers, values.captureLag > MAX_CAPTURE_LAG, 'capture_lag_exceeded', {
    actual: text(values.captureLag), maximum: text(MAX_CAPTURE_LAG),
  });
  add(blockers, !values.leases.capture.active, 'canonical_capture_inactive');
  add(blockers, values.journalStart == null || values.journalThrough == null,
    'canonical_journal_empty');
  add(blockers, values.row.activation_status == null, 'fresh_activation_missing');
  add(blockers, values.row.activation_status != null
    && values.row.activation_status !== 'active',
  'fresh_activation_inactive', values.row.activation_status);
  add(blockers, values.row.seed_status == null, 'fresh_seed_missing');
  add(blockers, values.row.seed_status != null && values.row.seed_status !== 'completed',
    'fresh_seed_incomplete', values.row.seed_status);
}

function validateWorkers(blockers, values) {
  const { leases, row, signedThrough } = values;
  add(blockers, !leases.firstBuy.active || !leases.firstBuy.running,
    'first_buy_worker_inactive');
  add(blockers, leases.firstBuy.last_error != null,
    'first_buy_worker_error', leases.firstBuy.last_error);
  add(blockers, signedThrough == null, 'signed_origin_cursor_missing');
  add(blockers, signedThrough != null
    && !['running', 'caught_up'].includes(row.signed_lifecycle_state),
  'signed_origin_cursor_inactive', row.signed_lifecycle_state);
  add(blockers, !leases.signedOrigin.active || !leases.signedOrigin.running,
    'signed_origin_worker_inactive');
  add(blockers, leases.signedOrigin.source_mode !== 'canonical_journal',
    'signed_origin_source_not_canonical', leases.signedOrigin.source_mode);
  add(blockers, leases.signedOrigin.last_error != null,
    'signed_origin_worker_error', leases.signedOrigin.last_error);
  add(blockers, !leases.fresh.active || !leases.fresh.running, 'fresh_worker_inactive');
  add(blockers, leases.fresh.last_error != null, 'fresh_worker_error', leases.fresh.last_error);
}

function validateCoverage(blockers, values) {
  const { row, sample } = values;
  add(blockers, row.activation_status != null
    && !['matched', 'before_journal'].includes(row.activation_checkpoint_status),
    'fresh_activation_checkpoint_not_canonical');
  add(blockers, row.live_cutoff_covered !== true, 'fresh_live_cutoff_not_covered');
  add(blockers, values.firstBuyThrough == null, 'first_buy_cursor_missing');
  add(blockers, values.firstBuyThrough != null
    && values.activationFirstBuyNext != null
    && values.firstBuyThrough + 1n < values.activationFirstBuyNext,
  'first_buy_frontier_before_activation');
  add(blockers, values.firstBuyJournalLag > 0n,
    'first_buy_frontier_not_captured', text(values.firstBuyJournalLag));
  add(blockers, values.signedLag > 0n,
    'signed_origin_behind_first_buy', text(values.signedLag));
  add(blockers, count(sample.sampled) > 0,
    'fresh_active_queue_not_drained', count(sample.sampled));
  add(blockers, count(sample.sampled) > 0 && count(sample.missing_blocks) > 0,
    'canonical_sample_missing_blocks', count(sample.missing_blocks));
  add(blockers, count(sample.missing_transactions) > 0,
    'canonical_sample_missing_transactions', count(sample.missing_transactions));
  add(blockers, count(sample.missing_nonces) > 0,
    'canonical_sample_missing_nonces', count(sample.missing_nonces));
  add(blockers, count(sample.divergent) > 0,
    'canonical_sample_divergent', count(sample.divergent));
}

function evaluate(input = {}) {
  const row = input.state || {}; const sample = input.sample || {};
  const captureNext = quantity(row.capture_next_block);
  const captureHead = quantity(row.capture_node_head);
  const captureLag = distance(captureNext, captureHead);
  const journalStart = quantity(row.journal_start_block);
  const journalThrough = quantity(row.journal_through_block);
  const firstBuyNext = quantity(row.first_buy_source_next_block);
  const firstBuyThrough = firstBuyNext == null ? null : firstBuyNext - 1n;
  const activationFirstBuyNext = quantity(row.activation_first_buy_next_block);
  const signedThrough = quantity(row.signed_checkpoint_block);
  const firstBuyJournalLag = distance(
    journalThrough == null ? null : journalThrough + 1n, firstBuyThrough
  );
  const signedLag = distance(signedThrough == null ? null : signedThrough + 1n,
    firstBuyThrough);
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, leaseSummary(input.leases || [], key)]
  )));
  const blockers = [];

  validateFoundation(blockers, {
    row, captureNext, captureHead, captureLag, journalStart, journalThrough, leases,
  });
  validateWorkers(blockers, { row, signedThrough, leases });
  validateCoverage(blockers, {
    row, sample, firstBuyThrough, activationFirstBuyNext, firstBuyJournalLag, signedLag,
  });

  return Object.freeze({
    mode: 'read-only', ready: blockers.length === 0, blockers,
    capture: { next_block: text(captureNext), node_head: text(captureHead),
      lag_blocks: text(captureLag), journal_start_block: text(journalStart),
      journal_through_block: text(journalThrough) },
    fresh: { activation_status: row.activation_status || null,
      seed_status: row.seed_status || null, activation_block: text(row.activation_block),
      activation_at: timestamp(row.activation_at),
      activation_checkpoint_status: row.activation_checkpoint_status || null,
      live_cutoff_covered: row.live_cutoff_covered === true },
    first_buy: { next_block: text(firstBuyNext), through_block: text(firstBuyThrough),
      source_through: timestamp(row.first_buy_source_through),
      lag_to_journal_blocks: text(firstBuyJournalLag) },
    signed_origin: { origin_block: text(row.signed_origin_block),
      checkpoint_block: text(signedThrough), lifecycle_state: row.signed_lifecycle_state || null,
      lag_to_first_buy_blocks: text(signedLag) },
    context: { sampled: count(sample.sampled), missing_blocks: count(sample.missing_blocks),
      missing_transactions: count(sample.missing_transactions),
      missing_nonces: count(sample.missing_nonces), divergent: count(sample.divergent),
      sample_limit: SAMPLE_LIMIT, sample_scope: 'active_queue' },
    contract: { target: 'robinhood_chain_blocks+robinhood_chain_transactions',
      first_buy_nonce: 'covered', cutoff_24h: 'covered_by_block_timestamps',
      prior_signed_activity: 'robinhood_wallet_signed_origins' },
    leases,
  });
}

function createRobinhoodCanonicalFreshWalletAudit(options = {}) {
  const database = options.database || db;
  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = (await client.query(`WITH journal AS MATERIALIZED (
        SELECT first.block_number AS start_block, first.block_timestamp AS start_time,
               latest.block_number AS through_block, latest.block_timestamp AS through_time
          FROM (VALUES (1)) anchor(value)
          LEFT JOIN LATERAL (SELECT block_number, block_timestamp
            FROM robinhood_chain_blocks WHERE chain=$1 AND canonical=TRUE
            ORDER BY block_number LIMIT 1) first ON TRUE
          LEFT JOIN LATERAL (SELECT block_number, block_timestamp
            FROM robinhood_chain_blocks
            WHERE chain=$1 AND canonical=TRUE ORDER BY block_number DESC LIMIT 1) latest ON TRUE
      ) SELECT capture.next_block AS capture_next_block,
          capture.node_head AS capture_node_head, journal.start_block AS journal_start_block,
          journal.through_block AS journal_through_block, activation.status AS activation_status,
          activation.activation_block, activation.activation_at,
          activation.first_buy_source_next_block AS activation_first_buy_next_block,
          CASE WHEN activation.activation_block IS NULL THEN NULL
            WHEN activation.activation_block<journal.start_block THEN 'before_journal'
            WHEN activation_block.block_hash=activation.activation_block_hash THEN 'matched'
            ELSE 'divergent' END AS activation_checkpoint_status,
          seed.status AS seed_status, signed.origin_block AS signed_origin_block,
          signed.checkpoint_block AS signed_checkpoint_block,
          signed.lifecycle_state AS signed_lifecycle_state,
          first_buy.source_next_block AS first_buy_source_next_block,
          first_buy.source_through AS first_buy_source_through,
          journal.through_time-INTERVAL '24 hours'>=journal.start_time
            AS live_cutoff_covered
        FROM journal
        LEFT JOIN robinhood_chain_capture_cursor capture ON capture.chain=$1
        LEFT JOIN robinhood_fresh_wallet_activations activation
          ON activation.chain=$1 AND activation.rule_version=$2
        LEFT JOIN robinhood_chain_blocks activation_block
          ON activation_block.chain=$1 AND activation_block.canonical=TRUE
         AND activation_block.block_number=activation.activation_block
        LEFT JOIN robinhood_fresh_wallet_seed_runs seed
          ON seed.chain=$1 AND seed.rule_version=$2
        LEFT JOIN robinhood_first_buy_live_cursors first_buy ON first_buy.chain=$1
        LEFT JOIN robinhood_wallet_signed_origin_cursors signed
          ON signed.chain=$1 AND signed.stream='live'`, [CHAIN, RULE_VERSION])).rows[0] || {};
      const sample = (await client.query(`WITH active_sample AS MATERIALIZED (
        SELECT chain, token_address, wallet_address FROM (
          (SELECT chain, token_address, wallet_address, next_attempt_at AS priority
             FROM robinhood_fresh_wallet_queue
            WHERE chain=$1 AND rule_version=$2 AND source_kind='live'
              AND status='pending'
            ORDER BY next_attempt_at, updated_at LIMIT $3)
          UNION ALL
          (SELECT chain, token_address, wallet_address, lease_until AS priority
             FROM robinhood_fresh_wallet_queue
            WHERE chain=$1 AND rule_version=$2 AND source_kind='live'
              AND status='leased'
            ORDER BY lease_until LIMIT $3)
        ) active ORDER BY priority LIMIT $3
      ), sample AS MATERIALIZED (
        SELECT q.wallet_address, buy.transaction_hash, buy.transaction_index,
               buy.block_number, buy.block_hash
          FROM active_sample q
          INNER JOIN robinhood_wallet_token_first_buys buy USING (
            chain, token_address, wallet_address)
      ) SELECT COUNT(*) AS sampled,
          COUNT(*) FILTER (WHERE block.block_hash IS NULL) AS missing_blocks,
          COUNT(*) FILTER (WHERE transaction.transaction_hash IS NULL) AS missing_transactions,
          COUNT(*) FILTER (WHERE transaction.transaction_hash IS NOT NULL
            AND transaction.nonce IS NULL) AS missing_nonces,
          COUNT(*) FILTER (WHERE transaction.transaction_hash IS NOT NULL AND (
            block.block_hash<>sample.block_hash
            OR transaction.transaction_index<>sample.transaction_index
            OR transaction.from_address<>sample.wallet_address)) AS divergent
        FROM sample LEFT JOIN robinhood_chain_blocks block
          ON block.chain=$1 AND block.canonical=TRUE AND block.block_number=sample.block_number
        LEFT JOIN robinhood_chain_transactions transaction
          ON transaction.chain=$1 AND transaction.block_hash=block.block_hash
         AND transaction.transaction_hash=sample.transaction_hash`,
      [CHAIN, RULE_VERSION, SAMPLE_LIMIT])).rows[0] || {};
      const leases = (await client.query(`SELECT lease_key, lease_until>NOW() AS active,
          heartbeat_at, metadata FROM worker_leases WHERE lease_key=ANY($1::varchar[])`,
      [Object.values(LEASE_KEYS)])).rows;
      await client.query('ROLLBACK');
      return evaluate({ state, sample, leases });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = { LEASE_KEYS, createRobinhoodCanonicalFreshWalletAudit, evaluate };
