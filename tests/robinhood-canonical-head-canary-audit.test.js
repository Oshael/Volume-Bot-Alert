'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalHeadCanaryAudit, evaluate,
} = require('../src/services/robinhood-canonical-head-canary-audit');
const { compact, parseArgs } = require('../src/utils/audit-robinhood-canonical-head-canary');

function lease(lease_key, metadata = {}) {
  return { lease_key, active: true, metadata };
}
function input(phase) {
  return {
    options: {
      phase, maxCaptureLag: 2, maxQueueLagBlocks: 2, minDiscovery: 1, minMarket: 100,
    },
    capture: { next_block: '1001', node_head: '1000', lag_blocks: '0' },
    queue: {
      pending: 2, leased: 0, blocked: 0, first_pending: '1000',
      first_unsettled: '1000', lag_blocks: '0',
    },
    leases: [
      lease('robinhood-chain-capture-worker'),
      lease('robinhood-head-capture-worker'),
    ],
    parity: [],
  };
}

describe('Robinhood canonical head canary audit', () => {
  it('approves preflight only after shadow and stale claims are gone', () => {
    assert.equal(evaluate(input('preflight')).approved, true);
    const blocked = input('preflight');
    blocked.leases.push(lease('robinhood-chain-domain-shadow-worker'));
    blocked.queue.leased = 2;
    blocked.queue.lag_blocks = 3;
    assert.deepEqual(evaluate(blocked).blockers.map(({ code }) => code), [
      'domain_shadow_still_active', 'domain_outbox_lag_exceeded',
      'domain_outbox_still_leased',
    ]);
  });

  it('accepts an unmatched tail but rejects mature gaps, divergence and forbidden RPC', () => {
    const state = input('canary');
    state.leases.push(lease('robinhood-canonical-head-worker', {
      canonicalRuntime: { rpcGuard: { forbiddenAttempts: 0 } },
    }));
    state.parity = [
      { stream: 'discovery', mature_candidates: 1, awaiting_legacy: 1,
        missing_legacy: 0, divergent: 0, matched: 1 },
      { stream: 'market', mature_candidates: 100, awaiting_legacy: 5,
        missing_legacy: 0, divergent: 0, matched: 100 },
    ];
    assert.equal(evaluate(state).approved, true);
    const runtime = state.leases.at(-1).metadata.canonicalRuntime;
    delete state.leases.at(-1).metadata.canonicalRuntime;
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'canonical_rpc_guard_missing',
    ]);
    state.leases.at(-1).metadata.canonicalRuntime = runtime;
    state.parity[1].missing_legacy = 1;
    state.parity[1].divergent = 2;
    state.leases.at(-1).metadata.canonicalRuntime.rpcGuard.forbiddenAttempts = 1;
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'forbidden_rpc_attempts', 'mature_legacy_missing', 'evidence_divergent',
    ]);
  });

  it('parses bounded audit phases', () => {
    assert.deepEqual(parseArgs(['--phase=canary', '--min-market=500', '--verbose']), {
      phase: 'canary', maxCaptureLag: 2, maxQueueLagBlocks: 2,
      minDiscovery: 1, minMarket: 500, verbose: true,
    });
    assert.throws(() => parseArgs(['--phase=cutover']), /preflight or canary/);
    assert.throws(() => parseArgs(['--unknown=1']), /unknown argument/);
  });

  it('scopes parity to the active canary acquisition timestamp', async () => {
    let parityOptions;
    const database = { query: async (sql) => ({ rows: sql.includes('worker_leases') ? [
      lease('robinhood-chain-capture-worker'), lease('robinhood-head-capture-worker'),
      { ...lease('robinhood-canonical-head-worker', {
        canonicalRuntime: { rpcGuard: { forbiddenAttempts: 0 } },
      }), acquired_at: '2026-09-04T02:00:00Z' },
    ] : [{
      next_block: '1001', node_head: '1000', lag_blocks: '0', pending: 0,
      leased: 0, blocked: 0, first_pending: null, first_unsettled: null,
      queue_lag_blocks: '0',
    }] }) };
    const candidates = { getParitySummary: async (options) => {
      parityOptions = options;
      return [
        { stream: 'discovery', mature_candidates: 1, missing_legacy: 0, divergent: 0 },
        { stream: 'market', mature_candidates: 100, missing_legacy: 0, divergent: 0 },
      ];
    } };
    const report = await createRobinhoodCanonicalHeadCanaryAudit({
      database, candidates,
    }).inspect({ phase: 'canary' });
    assert.deepEqual(parityOptions, { capturedAfter: '2026-09-04T02:00:00Z' });
    assert.equal(report.approved, true);
  });

  it('keeps compact output focused on the operational gate', () => {
    const state = evaluate(input('preflight'));
    assert.deepEqual(Object.keys(compact(state)), [
      'phase', 'approved', 'blockers', 'capture', 'queue', 'parity', 'canary',
    ]);
  });
});
