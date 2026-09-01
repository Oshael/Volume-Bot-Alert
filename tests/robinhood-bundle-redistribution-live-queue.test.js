const assert = require('node:assert/strict');
const { it } = require('node:test');

const {
  createRobinhoodBundleRedistributionLiveQueueRepository,
} = require('../src/models/robinhood-bundle-redistribution-live-queue');

const TOKEN = `0x${'1'.repeat(40)}`;

it('claims a bounded batch only behind an active activation', async () => {
  let captured;
  const repository = createRobinhoodBundleRedistributionLiveQueueRepository({
    database: { async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ token_address: TOKEN, observation_from_block: '101',
        event_through_block: '110', requested_version: '3', attempt_count: 2 }] };
    } },
  });
  const result = await repository.claimBatch({ owner: 'worker-1', limit: 500, leaseMs: 1 });
  assert.match(captured.sql, /activation\.status = 'active'/);
  assert.match(captured.sql, /FOR UPDATE OF queue SKIP LOCKED/);
  assert.equal(captured.params[2], 100);
  assert.equal(captured.params[4], 10_000);
  assert.deepEqual(result, [{ tokenAddress: TOKEN, observationFromBlock: '101',
    eventThroughBlock: '110', requestedVersion: '3', attemptCount: 2 }]);
});

it('retries only the exact leased version owned by the caller', async () => {
  let captured;
  const repository = createRobinhoodBundleRedistributionLiveQueueRepository({
    database: { async query(sql, params) { captured = { sql, params }; return { rowCount: 1 }; } },
  });
  assert.equal(await repository.retry({ tokenAddress: TOKEN, owner: 'worker-1',
    requestedVersion: '3', error: { code: 'not_ready', message: 'later' } }), true);
  assert.match(captured.sql, /status = 'leased' AND lease_owner = \$4/);
  assert.match(captured.sql, /requested_version = \$5::bigint/);
  assert.deepEqual(captured.params.slice(3, 5), ['worker-1', '3']);
});
