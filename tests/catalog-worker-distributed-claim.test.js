const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const catalogWorker = require('../src/services/catalog-worker');

const { selectDueForEvaluationCycle } = catalogWorker.__private;

describe('catalog worker distributed claim selection', () => {
  it('combines foreground and backlog lists with a bounded fairness reservation', async () => {
    const calls = [];
    const fakeCatalog = {
      async listDueForEvaluation(limit, options) {
        calls.push({ limit, options });
        const prefix = options.selectionClass === 'backlog' ? 'B' : 'H';
        return Array.from({ length: limit }, (_, index) => ({
          address: `${prefix}${index}`,
          monitor_priority: prefix === 'B' ? 'dormant' : 'high',
        }));
      },
    };

    const result = await selectDueForEvaluationCycle(
      { mode: 'normal' },
      { tokenCatalog: fakeCatalog, tokenBudget: 10, distributedClaimEnabled: false }
    );

    assert.equal(result.selectionMode, 'list-fair');
    assert.deepEqual(result.due.map((token) => token.address), [
      'H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'B0',
    ]);
    assert.deepEqual(calls, [
      { limit: 10, options: { selectionClass: 'foreground' } },
      { limit: 10, options: { selectionClass: 'backlog' } },
    ]);
  });

  it('uses distributed claim when enabled and Dex throttle is normal', async () => {
    const calls = [];
    const fakeCatalog = {
      async claimDueForEvaluation(limit, options) {
        calls.push({ method: 'claimDueForEvaluation', limit, options });
        return options.selectionClass === 'backlog'
          ? [{ address: 'LowToken', monitor_priority: 'low' }]
          : [{ address: 'HighToken', monitor_priority: 'high' }];
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

    assert.deepEqual(result.due.map((token) => token.address), ['HighToken', 'LowToken']);
    assert.equal(result.selectionMode, 'distributed-claim-fair');
    assert.equal(result.fairBacklogBudget, 1);
    assert.equal(result.fairBacklogSelected, 1);
    assert.equal(result.fallbackReason, null);
    assert.deepEqual(calls, [
      {
        method: 'claimDueForEvaluation',
        limit: 9,
        options: { claimTtlMs: 45000, selectionClass: 'foreground' },
      },
      {
        method: 'claimDueForEvaluation',
        limit: 1,
        options: { claimTtlMs: 45000, selectionClass: 'backlog' },
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
