const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodTokenDeploymentWorker,
} = require('../src/services/robinhood-token-deployment-worker');

const TOKEN = `0x${'a'.repeat(40)}`;
const DEPLOYMENT = { tokenAddress: TOKEN, source: 'blockscout_internal' };

function runtime(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      outbox: {
        claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1 }),
        isExact: async () => false,
        complete: async () => { calls.push('complete'); },
        retry: async (input) => { calls.push(['retry', input.error]); },
      },
      blockscout: { getContractCreation: async () => ({ creatorAddress: TOKEN, transactionHash: `0x${'b'.repeat(64)}` }) },
      verifier: { verifyDirectDeployment: async () => DEPLOYMENT },
      attributions: { recordVerifiedDirectDeployments: async () => { calls.push('attributed'); } },
      ...overrides,
    },
  };
}

it('materializes exact deployment evidence before completing the outbox task', async () => {
  const fixture = runtime();
  const worker = createRobinhoodTokenDeploymentWorker({ runtime: fixture.value, owner: 'test' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'resolved');
  assert.deepEqual(fixture.calls, ['attributed', 'complete']);
});

it('defers missing Blockscout evidence and skips already attributed tokens', async () => {
  const deferred = runtime({ blockscout: { getContractCreation: async () => null } });
  await createRobinhoodTokenDeploymentWorker({ runtime: deferred.value, owner: 'test' }).runOnce();
  assert.equal(deferred.calls[0][0], 'retry');
  const exact = runtime();
  exact.value.outbox.isExact = async () => true;
  const result = await createRobinhoodTokenDeploymentWorker({ runtime: exact.value, owner: 'test' }).runOnce();
  assert.equal(result.status, 'already-attributed');
  assert.deepEqual(exact.calls, ['complete']);
});
