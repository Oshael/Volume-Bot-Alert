'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { evaluate } = require('../src/services/robinhood-canonical-head-canary-audit');
const { parseArgs } = require('../src/utils/audit-robinhood-canonical-head-canary');

function lease(lease_key, metadata = {}) {
  return { lease_key, active: true, metadata };
}
function input(phase) {
  return {
    options: { phase, maxCaptureLag: 2, minDiscovery: 1, minMarket: 100 },
    capture: { next_block: '1001', node_head: '1000', lag_blocks: '0' },
    queue: { pending: 2, leased: 0, blocked: 0, first_pending: '1000' },
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
    assert.deepEqual(evaluate(blocked).blockers.map(({ code }) => code), [
      'domain_shadow_still_active', 'domain_outbox_still_leased',
    ]);
  });

  it('accepts an unmatched tail but rejects mature gaps, divergence and forbidden RPC', () => {
    const state = input('canary');
    state.leases.push(lease('robinhood-canonical-head-worker', {
      runtime: { rpcGuard: { forbiddenAttempts: 0 } },
    }));
    state.parity = [
      { stream: 'discovery', mature_candidates: 1, awaiting_legacy: 1,
        missing_legacy: 0, divergent: 0, matched: 1 },
      { stream: 'market', mature_candidates: 100, awaiting_legacy: 5,
        missing_legacy: 0, divergent: 0, matched: 100 },
    ];
    assert.equal(evaluate(state).approved, true);
    state.parity[1].missing_legacy = 1;
    state.parity[1].divergent = 2;
    state.leases.at(-1).metadata.runtime.rpcGuard.forbiddenAttempts = 1;
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'forbidden_rpc_attempts', 'mature_legacy_missing', 'evidence_divergent',
    ]);
  });

  it('parses bounded audit phases', () => {
    assert.deepEqual(parseArgs(['--phase=canary', '--min-market=500']), {
      phase: 'canary', maxCaptureLag: 2, minDiscovery: 1, minMarket: 500,
    });
    assert.throws(() => parseArgs(['--phase=cutover']), /preflight or canary/);
    assert.throws(() => parseArgs(['--unknown=1']), /unknown argument/);
  });
});
