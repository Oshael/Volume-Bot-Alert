const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodLaunchAnchorBackfillRepository,
  __private: { FIND_ANCHORS_SQL, TARGETS_SQL },
} = require('../src/models/robinhood-launch-anchor-backfill');
const {
  runPreflight, __private: { samples },
} = require('../src/services/robinhood-launch-anchor-backfill-preflight');

const HASH = `0x${'a'.repeat(64)}`;
const target = (index) => ({
  tokenAddress: `0x${String(index).padStart(40, '0')}`,
  firstPoolBlock: '10', sourceThroughBlock: '20', sourceThroughHash: HASH,
});

describe('Robinhood launch-anchor catch-up', () => {
  it('selects only live first-buy gaps under a complete frozen frontier', async () => {
    const calls = [];
    const database = { async queryWithStatementTimeout(sql, params, timeout) {
      calls.push({ sql, params, timeout });
      if (sql === TARGETS_SQL) return { rows: [
        { token_address: target(1).tokenAddress, first_pool_block: '10',
          source_through_block: '20', source_through_hash: HASH },
        { token_address: target(2).tokenAddress, first_pool_block: null,
          source_through_block: '20', source_through_hash: HASH },
      ] };
      return { rows: [{ source_next_block: '21', caught_up: true, seed_status: 'completed' }] };
    } };
    const repository = createRobinhoodLaunchAnchorBackfillRepository({
      database, statementTimeoutMs: 5_000,
    });
    const plan = await repository.loadPlan();
    assert.equal(plan.sourceThroughBlock, '20');
    assert.equal(plan.targets.length, 1);
    assert.equal(plan.unavailableWithoutPool, 1);
    assert.equal(calls.every((call) => call.timeout === 5_000), true);
    assert.match(calls[1].sql, /ledger_status = 'live'/);
    assert.match(calls[1].sql, /robinhood_wallet_token_first_buys/);
    await assert.rejects(repository.createRun({ report: { approved: false } }), /not approved/);
  });

  it('samples first, middle and last batches and enforces the five-hour cap', async () => {
    assert.deepEqual(samples(Array.from({ length: 10 }, (_, index) => index), 2, 3).batches,
      [[0, 1], [4, 5], [8, 9]]);
    const targets = Array.from({ length: 50 }, (_, index) => target(index + 1));
    const times = [0, 100, 100, 300, 300, 600];
    const { report, plan } = await runPreflight({
      async loadPlan() { return { ready: true, sourceThroughBlock: '20',
        unavailableWithoutPool: 0, targets }; },
      async probeTargets(batch) {
        return { targets: batch.length, anchors: batch.length, unavailable: 0 };
      },
    }, { batchSize: 10, sampleCount: 3, concurrency: 2, now: () => times.shift() });
    assert.equal(plan.targets.length, 50);
    assert.equal(report.averageSampleMs, 200);
    assert.equal(report.projectedMs, 625);
    assert.equal(report.approved, true);
    await assert.rejects(runPreflight({}, {}), /repository is required/);
    await assert.rejects(runPreflight({ loadPlan() {}, probeTargets() {} }, { maxHours: 6 }),
      /at most 5/);
    assert.match(FIND_ANCHORS_SQL, /ORDER BY swap\.block_time, swap\.block_number/);
  });
});
