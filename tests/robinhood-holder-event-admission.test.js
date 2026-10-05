const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodHolderEventAdmission } = require('../src/services/robinhood-holder-event-admission');
const TOKEN = `0x${'a'.repeat(40)}`;
const input = { admittedAfter: '2026-09-01', limit: 1000, maxInitialGapBlocks: 20_000 };
const task = { token_address: TOKEN, version: '2', attempt_count: 1, created_at: new Date(0) };
it('avoids per-tick discovery, wakes on events and admits only claimed identities', async () => {
  let time = 1000; let ready = false; let listenerOptions; let claims = 0; let wakes = 0; let stopped = false;
  const seeds = []; const settlements = [];
  const worker = createRobinhoodHolderEventAdmission({ now: () => time, onWake: () => { wakes += 1; },
    owner: 'test', queue: {
      claim: async ({ limit }) => { claims += 1; assert.equal(limit, 100); return ready ? [task] : []; },
      completedAddresses: async (addresses) => addresses,
      settle: async (value) => { settlements.push(value); return { completed: 1, deferred: 0 }; },
    }, bootstrap: { seedNewTokens: async (value) => { seeds.push(value); return [{ tokenAddress: TOKEN }]; } },
    listenerFactory: (options) => {
      listenerOptions = options;
      return { start: async () => {}, stop: async () => { stopped = true; } };
    },
  });
  worker.start();
  assert.equal(listenerOptions.shared, true);
  await worker.runDue(input);
  time += 500;
  await worker.runDue(input);
  assert.equal(claims, 1); assert.equal(seeds.length, 0);
  ready = true; listenerOptions.onNotification();
  assert.deepEqual(await worker.runDue(input), [{ tokenAddress: TOKEN }]);
  assert.deepEqual(seeds[0].tokenAddresses, [TOKEN]);
  assert.deepEqual(settlements[0].completed, [TOKEN]);
  assert.equal(wakes, 1); assert.equal(worker.getStatus().completed, 1);
  await worker.stop(); assert.equal(stopped, true);
});
it('reschedules failures without acknowledging work or bypassing backoff on notifications', async () => {
  let time = 1000; let listenerOptions; let claims = 0; let settlement;
  const worker = createRobinhoodHolderEventAdmission({ now: () => time, owner: 'test',
    queue: { claim: async () => { claims += 1; return [task]; },
      settle: async (value) => { settlement = value; return { completed: 0, deferred: 1 }; } },
    bootstrap: { seedNewTokens: async () => { throw new Error('storage unavailable'); } },
    listenerFactory: (options) => {
      listenerOptions = options;
      return { start: async () => { throw new Error('listener offline'); }, stop: async () => {} };
    },
  });
  worker.start();
  assert.deepEqual(await worker.runDue(input), []);
  assert.equal(settlement.completed, undefined);
  assert.equal(settlement.error, 'storage unavailable');
  listenerOptions.onNotification(); time += 100;
  assert.deepEqual(await worker.runDue(input), []); assert.equal(claims, 1);
  time += 5000;
  assert.deepEqual(await worker.runDue(input), []);
  assert.equal(claims, 2); assert.equal(worker.getStatus().deferred, 2);
  assert.equal(worker.getStatus().listenerError, 'listener offline');
  await worker.stop();
});
