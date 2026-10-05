const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodHolderAdmissionQueue } = require('../src/models/robinhood-holder-admission-queue');
it('bounds admission batches/leases and requires an owner before touching storage', async () => {
  const queue = createRobinhoodHolderAdmissionQueue({ database: {
    query() { assert.fail('invalid claims must not query'); },
  } });
  for (const input of [{}, { owner: '' }, { owner: 'a'.repeat(129) },
    { owner: 'worker', limit: 0 }, { owner: 'worker', limit: 101 },
    { owner: 'worker', leaseMs: 0 }, { owner: 'worker', leaseMs: 300001 }]) {
    await assert.rejects(queue.claim(input), /invalid admission/);
  }
  assert.deepEqual(await queue.settle({ tasks: [] }), { completed: 0, deferred: 0 });
  assert.deepEqual(await queue.completedAddresses([], '2026-09-10'), []);
});
