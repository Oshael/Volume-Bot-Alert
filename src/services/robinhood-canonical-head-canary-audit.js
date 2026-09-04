'use strict';

const db = require('../models/db');
const {
  createRobinhoodCanonicalHeadCandidateRepository,
} = require('../models/robinhood-canonical-head-candidate');

const LEASE_KEYS = Object.freeze({
  capture: 'robinhood-chain-capture-worker',
  legacy: 'robinhood-head-capture-worker',
  shadow: 'robinhood-chain-domain-shadow-worker',
  canary: 'robinhood-canonical-head-worker',
});

function count(value) {
  return Number(value) || 0;
}
function activeLease(rows, key) {
  return rows.find((row) => row.lease_key === key) || {
    lease_key: key, active: false, metadata: {}, heartbeat_at: null, lease_until: null,
  };
}
function add(blockers, condition, code, detail = null) {
  if (condition) blockers.push(detail == null ? { code } : { code, detail });
}

function evaluate(input) {
  const {
    phase, maxCaptureLag, maxQueueLagBlocks, minDiscovery, minMarket,
  } = input.options;
  const capture = input.capture || null;
  const queue = input.queue || {};
  const leases = Object.fromEntries(Object.entries(LEASE_KEYS).map(([name, key]) => (
    [name, activeLease(input.leases || [], key)]
  )));
  const parity = Object.fromEntries(['discovery', 'market'].map((stream) => (
    [stream, input.parity.find((row) => row.stream === stream) || {
      stream, candidates: 0, mature_candidates: 0, awaiting_legacy: 0,
      missing_legacy: 0, matched: 0, divergent: 0,
    }]
  )));
  const blockers = [];
  add(blockers, !capture, 'capture_cursor_missing');
  add(blockers, count(capture?.lag_blocks) > maxCaptureLag, 'capture_lag_exceeded', {
    actual: count(capture?.lag_blocks), maximum: maxCaptureLag,
  });
  add(blockers, !leases.capture.active, 'canonical_capture_inactive');
  add(blockers, !leases.legacy.active, 'legacy_head_inactive');
  add(blockers, leases.shadow.active, 'domain_shadow_still_active');
  add(blockers, count(queue.lag_blocks) > maxQueueLagBlocks, 'domain_outbox_lag_exceeded', {
    actual: count(queue.lag_blocks), maximum: maxQueueLagBlocks,
    firstUnsettled: queue.first_unsettled || null,
  });
  add(blockers, count(queue.blocked) > 0, 'domain_outbox_blocked', count(queue.blocked));
  add(blockers, leases.canary.metadata?.state === 'halted', 'canonical_canary_lease_halted',
    leases.canary.metadata?.haltCode || null);

  if (phase === 'preflight') {
    add(blockers, leases.canary.active, 'canonical_canary_already_active');
    add(blockers, count(queue.leased) > 0, 'domain_outbox_still_leased', count(queue.leased));
  } else {
    add(blockers, !leases.canary.active, 'canonical_canary_inactive');
    const rpcGuard = leases.canary.metadata?.canonicalRuntime?.rpcGuard || null;
    add(blockers, leases.canary.active && !rpcGuard, 'canonical_rpc_guard_missing');
    const forbidden = count(rpcGuard?.forbiddenAttempts);
    add(blockers, forbidden > 0, 'forbidden_rpc_attempts', forbidden);
    for (const [stream, minimum] of [['discovery', minDiscovery], ['market', minMarket]]) {
      add(blockers, count(parity[stream].mature_candidates) < minimum,
        'insufficient_mature_samples', {
          stream, actual: count(parity[stream].mature_candidates), minimum,
        });
      add(blockers, count(parity[stream].missing_legacy) > 0, 'mature_legacy_missing', {
        stream, count: count(parity[stream].missing_legacy),
      });
      add(blockers, count(parity[stream].divergent) > 0, 'evidence_divergent', {
        stream, count: count(parity[stream].divergent),
      });
    }
  }
  return Object.freeze({
    phase, approved: blockers.length === 0, blockers, capture, queue, leases, parity,
  });
}

function createRobinhoodCanonicalHeadCanaryAudit(deps = {}) {
  const database = deps.database || db;
  const candidates = deps.candidates
    || createRobinhoodCanonicalHeadCandidateRepository({ database });

  async function inspect(options = {}) {
    const normalized = {
      phase: options.phase === 'canary' ? 'canary' : 'preflight',
      maxCaptureLag: count(options.maxCaptureLag ?? 2),
      maxQueueLagBlocks: count(options.maxQueueLagBlocks ?? 2),
      minDiscovery: count(options.minDiscovery ?? 1),
      minMarket: count(options.minMarket ?? 100),
    };
    const [state, leaseResult] = await Promise.all([
      database.query(
        `SELECT cursor.next_block::text, cursor.node_head::text,
                GREATEST(cursor.node_head-cursor.next_block+1, 0)::text AS lag_blocks,
                COUNT(*) FILTER (WHERE outbox.status='pending')::int AS pending,
                COUNT(*) FILTER (WHERE outbox.status='leased')::int AS leased,
                COUNT(*) FILTER (WHERE outbox.status='blocked')::int AS blocked,
                MIN(outbox.block_number) FILTER (WHERE outbox.status='pending')::text AS first_pending,
                MIN(outbox.block_number) FILTER (
                  WHERE outbox.status IN ('pending', 'leased')
                )::text AS first_unsettled,
                CASE WHEN COUNT(*) FILTER (
                  WHERE outbox.status IN ('pending', 'leased')
                )=0 THEN 0 ELSE GREATEST(cursor.next_block-1-MIN(outbox.block_number) FILTER (
                  WHERE outbox.status IN ('pending', 'leased')
                ), 0) END::text AS queue_lag_blocks
           FROM robinhood_chain_capture_cursor cursor
           LEFT JOIN robinhood_chain_domain_outbox outbox ON outbox.chain=cursor.chain
          WHERE cursor.chain='robinhood'
          GROUP BY cursor.next_block, cursor.node_head`
      ),
      database.query(
        `SELECT lease_key, lease_until>NOW() AS active, acquired_at,
                heartbeat_at, lease_until, metadata
           FROM worker_leases WHERE lease_key=ANY($1::varchar[])`, [Object.values(LEASE_KEYS)]
      ),
    ]);
    const row = state.rows[0] || null;
    const canaryLease = activeLease(leaseResult.rows, LEASE_KEYS.canary);
    const parity = normalized.phase === 'canary' && canaryLease.active
      ? await candidates.getParitySummary({ capturedAfter: canaryLease.acquired_at }) : [];
    return evaluate({
      options: normalized,
      capture: row && {
        next_block: row.next_block, node_head: row.node_head, lag_blocks: row.lag_blocks,
      },
      queue: row && {
        pending: row.pending, leased: row.leased, blocked: row.blocked,
        first_pending: row.first_pending, first_unsettled: row.first_unsettled,
        lag_blocks: row.queue_lag_blocks,
      },
      leases: leaseResult.rows,
      parity,
    });
  }

  return Object.freeze({ inspect });
}

module.exports = { LEASE_KEYS, createRobinhoodCanonicalHeadCanaryAudit, evaluate };
