const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createRobinhoodDerivedRunner,
  backoffFor,
} = require('../src/services/robinhood-derived-runner');

function fakeRepository(claimRows) {
  return {
    settleCalls: [],
    reclaimCount: 0,
    async reclaimExpiredLeases() { this.reclaimCount += 1; return 2; },
    async claimOutbox() { return claimRows; },
    async settleOutbox(input) {
      this.settleCalls.push(input);
      return {
        delivered: (input.delivered || []).length,
        retried: (input.retry || []).length,
        blocked: 0,
      };
    },
  };
}

describe('robinhood derived runner', () => {
  it('requires an outbox repository and a fan-out', () => {
    assert.throws(() => createRobinhoodDerivedRunner({ fanout: () => true }), /repository is required/);
    assert.throws(
      () => createRobinhoodDerivedRunner({ repository: { claimOutbox() {} } }),
      /fanout is required/
    );
  });

  it('fans out claimed rows and settles them as delivered', async () => {
    const rows = [
      { id: '1', payload: { address: '0xa' }, attemptCount: 1 },
      { id: '2', payload: { address: '0xb' }, attemptCount: 1 },
    ];
    const seen = [];
    const repository = fakeRepository(rows);
    const runner = createRobinhoodDerivedRunner({
      repository,
      fanout: (payload) => { seen.push(payload); return true; },
      options: { owner: 'derived-test' },
    });

    const result = await runner.runOnce();

    assert.deepEqual(seen.map((payload) => payload.address), ['0xa', '0xb']);
    assert.equal(repository.settleCalls.length, 1);
    assert.deepEqual(repository.settleCalls[0].delivered, ['1', '2']);
    assert.deepEqual(repository.settleCalls[0].retry, []);
    assert.equal(result.claimed, 2);
    assert.equal(result.reclaimed, 2);
  });

  it('delivers a row even when the fan-out reports no live subscriber', async () => {
    const rows = [{ id: '1', payload: { address: '0xa' }, attemptCount: 1 }];
    const repository = fakeRepository(rows);
    // Falsy return must not be treated as a failure — the durable data already
    // exists; only a thrown error reschedules.
    const runner = createRobinhoodDerivedRunner({ repository, fanout: () => false });

    await runner.runOnce();

    assert.deepEqual(repository.settleCalls[0].delivered, ['1']);
    assert.deepEqual(repository.settleCalls[0].retry, []);
  });

  it('retries only the row whose fan-out throws, delivering the rest', async () => {
    const rows = [
      { id: '1', payload: { address: '0xa' }, attemptCount: 2 },
      { id: '2', payload: { address: '0xb' }, attemptCount: 2 },
    ];
    const repository = fakeRepository(rows);
    const runner = createRobinhoodDerivedRunner({
      repository,
      fanout: (payload) => { if (payload.address === '0xa') throw new Error('relay down'); return true; },
      options: { owner: 'derived-test', baseBackoffMs: 1000, maxBackoffMs: 300000 },
      logger: { error() {} },
    });

    await runner.runOnce();

    const settle = repository.settleCalls[0];
    assert.deepEqual(settle.delivered, ['2']);
    assert.equal(settle.retry.length, 1);
    assert.equal(settle.retry[0].id, '1');
    assert.equal(settle.retry[0].error, 'relay down');
    assert.equal(settle.retry[0].backoffMs, backoffFor(2, 1000, 300000));
  });

  it('waits for asynchronous fan-out publication before settling', async () => {
    const rows = [{ id: '1', payload: { address: '0xa' }, attemptCount: 1 }];
    const repository = fakeRepository(rows);
    const runner = createRobinhoodDerivedRunner({
      repository,
      fanout: async () => { throw new Error('pg notify failed'); },
      logger: { error() {} },
    });

    await runner.runOnce();

    assert.deepEqual(repository.settleCalls[0].delivered, []);
    assert.equal(repository.settleCalls[0].retry[0].error, 'pg notify failed');
  });

  it('does not settle when nothing is claimed', async () => {
    const repository = fakeRepository([]);
    const runner = createRobinhoodDerivedRunner({ repository, fanout: () => true });

    const result = await runner.runOnce();

    assert.equal(repository.settleCalls.length, 0);
    assert.deepEqual([result.claimed, result.delivered, result.retried], [0, 0, 0]);
  });
});
