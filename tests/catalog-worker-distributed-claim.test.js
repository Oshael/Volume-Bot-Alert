const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const catalogWorker = require('../src/services/catalog-worker');

const { selectDueForEvaluationCycle } = catalogWorker.__private;

describe('catalog worker distributed claim selection', () => {
  it('uses distributed claim when enabled and Dex throttle is normal', async () => {
    const calls = [];
    const fakeCatalog = {
      async claimDueForEvaluation(limit, options) {
        calls.push({ method: 'claimDueForEvaluation', limit, options });
        return [{ address: 'HighToken', monitor_priority: 'high' }];
      },
      async listDueForEvaluation() {
        calls.push({ method: 'listDueForEvaluation' });
        return [];
      },
    };

    const result = await selectDueForEvaluationCycle(
      { mode: 'normal' },
      {
        tokenCatalog: fakeCatalog,
        tokenBudget: 10,
        distributedClaimEnabled: true,
        claimTtlMs: 45000,
      }
    );

    assert.deepEqual(result.due.map((token) => token.address), ['HighToken']);
    assert.equal(result.selectionMode, 'distributed-claim');
    assert.equal(result.fallbackReason, null);
    assert.deepEqual(calls, [
      {
        method: 'claimDueForEvaluation',
        limit: 10,
        options: { claimTtlMs: 45000 },
      },
    ]);
  });

  it('falls back to list selection during Dex throttle to avoid claiming filtered tokens', async () => {
    const calls = [];
    const fakeCatalog = {
      async claimDueForEvaluation() {
        calls.push({ method: 'claimDueForEvaluation' });
        return [];
      },
      async listDueForEvaluation(limit) {
        calls.push({ method: 'listDueForEvaluation', limit });
        return [
          { address: 'HighToken', monitor_priority: 'high', last_mcap: 150000 },
          { address: 'LowToken', monitor_priority: 'low', last_mcap: 1000 },
        ];
      },
    };

    const result = await selectDueForEvaluationCycle(
      { mode: 'cooldown' },
      {
        tokenCatalog: fakeCatalog,
        tokenBudget: 10,
        distributedClaimEnabled: true,
      }
    );

    assert.deepEqual(result.due.map((token) => token.address), ['HighToken']);
    assert.equal(result.selectionMode, 'list-fallback');
    assert.equal(result.fallbackReason, 'throttle-active');
    assert.deepEqual(calls, [
      {
        method: 'listDueForEvaluation',
        limit: 80,
      },
    ]);
  });
});
