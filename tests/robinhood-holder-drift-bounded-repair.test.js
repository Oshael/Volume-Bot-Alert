const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runBoundedDriftRepair,
  __private,
} = require('../src/utils/repair-robinhood-holder-drift-bounded');

const TOKEN = `0x${'a'.repeat(40)}`;
const WALLET = `0x${'b'.repeat(40)}`;

function candidate(overrides = {}) {
  return {
    tokenAddress: TOKEN, version: '7', backfillNextBlock: '100',
    status: 'deficit-found', classification: 'missing-or-implicit-credit-before-block',
    failedBlock: '109', sender: WALLET, localBalanceAtBlockStart: '40',
    historicalBalanceAtPrecedingBlock: '100',
    receiptEvidence: { status: 'match', fromBlock: '100', toBlock: '109' },
    ...overrides,
  };
}

function transactionalDatabase(handler) {
  return {
    getClient: async () => ({ query: handler, release() {} }),
  };
}

describe('Robinhood bounded holder drift repair', () => {
  it('admits only exact evidence inside both replay budgets', () => {
    const options = __private.normalizeOptions({
      maxReplayBlocks: 250, maxTotalReplayBlocks: 300,
    });
    assert.deepEqual(__private.chooseAction(candidate(), '199', options, 0), {
      action: 'repair', eligible: true, creditRaw: '60', replayBlocks: 100,
    });
    assert.equal(__private.chooseAction(candidate(), '400', options, 0).reason,
      'token_replay_limit_exceeded');
    assert.equal(__private.chooseAction(candidate(), '199', options, 250).reason,
      'total_replay_limit_exceeded');
    assert.equal(__private.chooseAction(candidate({
      receiptEvidence: { status: 'mismatch', fromBlock: '100', toBlock: '109' },
    }), '199', options, 0).reason, 'incomplete_repair_evidence');
    assert.equal(__private.chooseAction(candidate({
      classification: 'same-block-or-nonstandard-transfer-semantics',
    }), '199', options, 0).reason, 'unproven_drift');
  });

  it('anchors an existing balance and requeues with a fenced transaction', async () => {
    const calls = [];
    const database = transactionalDatabase(async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT token_address FROM robinhood_holder_token_states/.test(sql)) {
        return { rowCount: 1, rows: [{ token_address: TOKEN }] };
      }
      if (/SELECT balance_raw FROM robinhood_holder_balances/.test(sql)) {
        return { rowCount: 1, rows: [{ balance_raw: '25' }] };
      }
      if (/UPDATE robinhood_holder_token_states/.test(sql)) {
        return { rowCount: 1, rows: [{ version: '8' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const result = await __private.anchorCandidate(database, candidate(), {
      creditRaw: '60', replayBlocks: 100,
    });
    assert.equal(result.status, 'repaired');
    assert.match(calls.find(({ sql }) => /SET balance_raw/.test(sql)).sql,
      /balance_raw \+ \$3::numeric/);
    assert.match(calls.find(({ sql }) => /SET ledger_status/.test(sql)).sql,
      /ledger_status = 'backfilling'/);
    assert.equal(calls.at(-1).sql, 'COMMIT');
  });

  it('suppresses an unprovable token without deleting its retained journal', async () => {
    const calls = [];
    const database = transactionalDatabase(async (sql) => {
      calls.push(sql);
      if (/SELECT token_address FROM robinhood_holder_token_states/.test(sql)) {
        return { rowCount: 1, rows: [{ token_address: TOKEN }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const result = await __private.suppressCandidate(
      database, candidate(), 'unproven_drift'
    );
    assert.equal(result.status, 'suppressed');
    assert.ok(calls.some((sql) => /INSERT INTO admin_blocked_tokens/.test(sql)));
    assert.ok(calls.some((sql) => /eligibility_state = 'admin-blocked'/.test(sql)));
    assert.ok(calls.some((sql) => /status = 'excluded'/.test(sql)));
    assert.ok(calls.some((sql) => /DELETE FROM robinhood_holder_balances/.test(sql)));
    assert.ok(calls.some((sql) => /DELETE FROM robinhood_holder_token_states/.test(sql)));
    assert.ok(!calls.some((sql) => /DELETE FROM robinhood_holder_transfer_journal/.test(sql)));
  });

  it('is dry-run by default and returns a compact aggregate', async () => {
    const database = {
      query: async () => ({ rows: [{ count: '1' }] }),
      getClient: async () => assert.fail('dry-run must not open a writer transaction'),
    };
    const result = await runBoundedDriftRepair({
      database, maxReplayBlocks: 1000, maxTotalReplayBlocks: 1000,
      probe: async () => ({ provider: 'archive', safeHead: '199', results: [candidate()] }),
    });
    assert.equal(result.mode, 'dry-run');
    assert.deepEqual(result.summary, {
      inspected: 1, repairable: 1, suppressible: 0, repaired: 0,
      suppressed: 0, stale: 0, failed: 0, scheduledReplayBlocks: 100,
    });
    assert.equal(result.samples.repair[0].tokenAddress, TOKEN);
  });
});
