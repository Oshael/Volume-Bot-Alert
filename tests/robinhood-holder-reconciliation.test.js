const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderReconciliationRepository,
} = require('../src/models/robinhood-holder-reconciliation');
const {
  createRobinhoodHolderReconciliation,
} = require('../src/services/robinhood-holder-reconciliation');

const TOKEN = `0x${'a'.repeat(40)}`;

function candidate(overrides = {}) {
  return { tokenAddress: TOKEN, holderCount: '42', version: 1, lastReconciledAt: null, ...overrides };
}

describe('Robinhood holder reconciliation', () => {
  it('promotes only after three distinct exact observations', async () => {
    let state = candidate();
    let observedAt = 0;
    const writes = [];
    const repository = {
      getNextCandidate: async () => state,
      getCandidate: async () => state,
      recordComparison: async (input) => {
        writes.push(input);
        state = candidate({ version: state.version + 1, lastReconciledAt: input.observedAt });
        return { ...state, status: input.promote ? 'live' : 'shadow' };
      },
    };
    const reconciler = createRobinhoodHolderReconciliation({
      repository,
      observeHolderCount: async () => ({
        available: true, holderCount: '42',
        observedAt: new Date(Date.UTC(2026, 7, 10, 12, observedAt++)).toISOString(),
      }),
    });

    assert.equal((await reconciler.runOnce()).status, 'matching');
    assert.equal((await reconciler.runOnce()).matches, 2);
    assert.deepEqual(await reconciler.runOnce(), {
      status: 'live', tokenAddress: TOKEN, localHolderCount: '42',
      observedHolderCount: '42', matches: 3, version: 4,
    });
    assert.deepEqual(writes.map(({ promote }) => promote), [false, false, true]);
  });

  it('resets transient state on mismatch, unavailable data and stale observations', async () => {
    let state = candidate();
    let observation = { available: true, holderCount: 42, observedAt: '2026-08-10T12:00:00Z' };
    let writes = 0;
    const repository = {
      getNextCandidate: async () => state,
      getCandidate: async () => state,
      recordComparison: async (input) => {
        writes += 1;
        state = candidate({ version: state.version + 1, lastReconciledAt: input.observedAt });
        return { ...state, status: 'shadow' };
      },
    };
    const reconciler = createRobinhoodHolderReconciliation({
      repository, observeHolderCount: async () => observation,
    });

    assert.equal((await reconciler.runOnce()).status, 'matching');
    assert.equal((await reconciler.runOnce()).status, 'waiting');
    assert.equal(writes, 1);
    observation = { ...observation, holderCount: 41, observedAt: '2026-08-10T12:01:00Z' };
    assert.equal((await reconciler.runOnce()).status, 'mismatch');
    observation = { available: false };
    assert.equal((await reconciler.runOnce()).status, 'unavailable');
    assert.equal(writes, 2);
  });

  it('guards candidate selection and promotion with shadow state, version and empty tail', async () => {
    const calls = [];
    const database = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{
          token_address: TOKEN, holder_count: '42', version: '2',
          last_reconciled_at: '2026-08-10T12:00:00Z', ledger_status: 'live',
        }] };
      },
    };
    const repository = createRobinhoodHolderReconciliationRepository({ database });
    assert.equal((await repository.getNextCandidate()).holderCount, '42');
    const saved = await repository.recordComparison({
      tokenAddress: TOKEN, expectedHolderCount: '42', expectedVersion: 2,
      observedAt: '2026-08-10T12:01:00Z', promote: true,
    });
    assert.equal(saved.status, 'live');
    assert.match(calls[0].sql, /ledger_status = 'shadow'/);
    assert.match(calls[0].sql, /journal\.applied = false/);
    assert.match(calls[1].sql, /state\.version = \$2::bigint/);
    assert.match(calls[1].sql, /state\.holder_count = \$3::bigint/);
    assert.match(calls[1].sql, /state\.last_reconciled_at < \$4::timestamptz/);

    await repository.getNextLiveCandidate();
    await repository.recordLiveAudit({
      tokenAddress: TOKEN, expectedHolderCount: '42', expectedVersion: 2,
      observedAt: '2026-08-10T12:02:00Z',
    });
    assert.match(calls[2].sql, /ledger_status = 'live'/);
    assert.match(calls[3].sql, /state\.ledger_status = 'live'/);
    assert.doesNotMatch(calls[3].sql, /ledger_status = CASE/);
  });
});
