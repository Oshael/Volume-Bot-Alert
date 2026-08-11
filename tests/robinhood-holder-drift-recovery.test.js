const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runDriftRecovery,
} = require('../src/utils/robinhood-holder-drift-recovery');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;
const TOKEN_C = `0x${'3'.repeat(40)}`;

function result(tokenAddress, status, overrides = {}) {
  return {
    tokenAddress, status, deploymentBlock: '100', backfillNextBlock: '200',
    liveThroughBlock: '199', holderCount: '1', version: '7', ...overrides,
  };
}

describe('Robinhood holder drift recovery', () => {
  it('discovers every eligible token through cursor pagination without writes in dry-run', async () => {
    const cursors = [];
    const probe = async ({ afterTokenAddress }) => {
      cursors.push(afterTokenAddress);
      return afterTokenAddress == null
        ? { provider: 'node', safeHead: '500', results: [
          result(TOKEN_A, 'not-reproduced'), result(TOKEN_B, 'deficit-found'),
        ] }
        : { provider: 'node', safeHead: '501', results: [
          result(TOKEN_C, 'not-reproduced'),
        ] };
    };
    const queries = [];
    const database = { async query(sql) {
      queries.push(sql);
      return { rows: [{ tokens: 3 }] };
    } };

    const recovered = await runDriftRecovery({ database, probe, batchSize: 2 });

    assert.deepEqual(cursors, [null, TOKEN_B]);
    assert.equal(recovered.mode, 'dry-run');
    assert.deepEqual(recovered.eligibleTokens, [TOKEN_A, TOKEN_C]);
    assert.deepEqual(recovered.unsafeTokens, []);
    assert.deepEqual(recovered.requeuedTokens, []);
    assert.equal(recovered.remainingDrifted, 3);
    assert.equal(queries.every((sql) => /^\s*SELECT/.test(sql)), true);
  });

  it('requeues only freshly revalidated candidates with cursor and version CAS', async () => {
    const queries = [];
    const database = { async query(sql, params) {
      queries.push([sql, params]);
      if (/^\s*UPDATE/.test(sql)) return { rowCount: 1, rows: [{ token_address: TOKEN_A }] };
      return { rows: [{ tokens: 1 }] };
    } };
    const probe = async () => ({ provider: 'node', safeHead: '500', results: [
      result(TOKEN_A, 'not-reproduced'),
      result(TOKEN_C, 'not-reproduced', { liveThroughBlock: '250' }),
      result(TOKEN_B, 'deficit-found', { classification: 'archive-state-unavailable' }),
    ] });

    const recovered = await runDriftRecovery({
      database, probe, batchSize: 25, confirm: true,
    });

    assert.equal(recovered.mode, 'confirmed');
    assert.deepEqual(recovered.requeuedTokens, [TOKEN_A]);
    assert.deepEqual(recovered.unsafeTokens, [TOKEN_C]);
    assert.deepEqual(recovered.staleTokens, []);
    assert.equal(recovered.remainingDrifted, 1);
    const update = queries.find(([sql]) => /^\s*UPDATE/.test(sql));
    assert.deepEqual(update[1], [TOKEN_A, '7', '200']);
    assert.match(update[0], /ledger_status = 'drifted' AND version = \$2::bigint/);
    assert.match(update[0], /live_through_block \+ 1 = backfill_next_block/);
  });
});
