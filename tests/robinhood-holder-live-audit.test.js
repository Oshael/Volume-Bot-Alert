const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLiveAudit,
} = require('../src/services/robinhood-holder-live-audit');

const TOKEN = `0x${'b'.repeat(40)}`;

function candidate(overrides = {}) {
  return { tokenAddress: TOKEN, holderCount: '42', version: 1, lastReconciledAt: null, ...overrides };
}

function repositoryState() {
  let state = candidate();
  const writes = [];
  return {
    writes,
    repository: {
      getNextLiveCandidate: async () => state,
      getLiveCandidate: async () => state,
      recordLiveAudit: async (input) => {
        writes.push(input);
        state = candidate({ version: state.version + 1, lastReconciledAt: input.observedAt });
        return state;
      },
    },
  };
}

describe('Robinhood holder live audit', () => {
  it('reports suspected drift only after three stable distinct mismatches', async () => {
    const state = repositoryState();
    let minute = 0;
    const audit = createRobinhoodHolderLiveAudit({
      repository: state.repository,
      observeHolderCount: async () => ({
        available: true, holderCount: 40,
        observedAt: new Date(Date.UTC(2026, 7, 10, 12, minute++)).toISOString(),
      }),
    });

    assert.equal((await audit.runOnce()).status, 'live-mismatch');
    assert.equal((await audit.runOnce()).mismatches, 2);
    assert.deepEqual(await audit.runOnce(), {
      status: 'drift-suspected', tokenAddress: TOKEN,
      localHolderCount: '42', observedHolderCount: '40', mismatches: 3, version: 4,
    });
    assert.equal(state.writes.length, 3);
    assert.equal(state.writes.some((write) => 'promote' in write), false);
  });

  it('resets the evidence when either count changes and verifies exact matches', async () => {
    const state = repositoryState();
    const observations = [40, 41, 41, 42].map((holderCount, index) => ({
      available: true, holderCount,
      observedAt: new Date(Date.UTC(2026, 7, 10, 12, index)).toISOString(),
    }));
    const audit = createRobinhoodHolderLiveAudit({
      repository: state.repository,
      observeHolderCount: async () => observations.shift(),
    });

    assert.equal((await audit.runOnce()).mismatches, 1);
    assert.equal((await audit.runOnce()).mismatches, 1);
    assert.equal((await audit.runOnce()).mismatches, 2);
    const verified = await audit.runOnce();
    assert.equal(verified.status, 'live-verified');
    assert.equal(verified.mismatches, 0);
  });

  it('waits for a newer observation and drops transient evidence when unavailable', async () => {
    const state = repositoryState();
    let observed = { available: true, holderCount: 40, observedAt: '2026-08-10T12:00:00Z' };
    const audit = createRobinhoodHolderLiveAudit({
      repository: state.repository, observeHolderCount: async () => observed,
    });
    assert.equal((await audit.runOnce()).status, 'live-mismatch');
    assert.equal((await audit.runOnce()).status, 'waiting');
    observed = { available: false };
    assert.equal((await audit.runOnce()).status, 'unavailable');
    assert.equal(state.writes.length, 1);
  });
});
