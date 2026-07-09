const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenCatalog = require('../src/models/token-catalog');

describe('token catalog distributed evaluation claim', () => {
  it('claims due evaluation rows with skip-locked ownership and a retry ttl', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [
            {
              address: 'TokenA',
              next_evaluation_at: new Date('2026-07-09T10:00:00.000Z'),
            },
          ],
        };
      },
    };

    const rows = await tokenCatalog.claimDueForEvaluation(12, { claimTtlMs: 45000 }, runner);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, 'TokenA');
    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(calls[0].sql, /UPDATE token_catalog tc/);
    assert.match(calls[0].sql, /SET next_evaluation_at = NOW\(\) \+ \(\$2::int \* INTERVAL '1 millisecond'\)/);
    assert.deepEqual(calls[0].params, [12, 45000]);
  });

  it('clamps unsafe claim limits and ttl values', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    await tokenCatalog.claimDueForEvaluation(100000, { claimTtlMs: 1 }, runner);

    assert.deepEqual(calls[0].params, [5000, 1000]);
  });
});
