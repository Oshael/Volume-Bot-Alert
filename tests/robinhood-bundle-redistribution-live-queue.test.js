const assert = require('node:assert/strict');
const { it } = require('node:test');

const {
  createRobinhoodBundleRedistributionLiveQueueRepository,
  __private: { assertedLineage },
} = require('../src/models/robinhood-bundle-redistribution-live-queue');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TIME = '2026-09-20T12:00:00.000Z';

it('claims a bounded batch only behind an active activation', async () => {
  let captured;
  const repository = createRobinhoodBundleRedistributionLiveQueueRepository({
    database: { async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ token_address: TOKEN, observation_from_block: '101',
        observation_from_hash: HASH, observation_from_time: TIME,
        event_through_block: '110', requested_version: '3',
        source_through_block: '120', source_through_hash: HASH,
        source_through_time: TIME, source_requested_version: '3', attempt_count: 2 }] };
    } },
  });
  const result = await repository.claimBatch({ owner: 'worker-1', limit: 500, leaseMs: 1 });
  assert.match(captured.sql, /activation\.status = 'active'/);
  assert.match(captured.sql, /FOR UPDATE OF queue SKIP LOCKED/);
  assert.match(captured.sql, /capture_robinhood_chain_block_anchor/);
  assert.match(captured.sql, /source_requested_version = CASE/);
  assert.match(captured.sql, /live_through_block >= event_through_block/);
  assert.equal(captured.params[2], 100);
  assert.equal(captured.params[4], 10_000);
  assert.deepEqual(result, [{ tokenAddress: TOKEN, observationFromBlock: '101',
    observationFromHash: HASH, observationFromTime: TIME,
    eventThroughBlock: '110', requestedVersion: '3', sourceThroughBlock: '120',
    sourceThroughHash: HASH, sourceThroughTime: TIME,
    sourceRequestedVersion: '3', attemptCount: 2 }]);
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
  assert.doesNotMatch(captured.sql, /SET[\s\S]*source_through_block/);
  assert.deepEqual(captured.params.slice(3, 5), ['worker-1', '3']);
});

it('accepts completion only for the exact durable frontier returned by claim', () => {
  const row = { event_through_block: '110', observation_from_hash: HASH,
    observation_from_time: TIME,
    observation_from_block: '101',
    source_through_block: '120', source_through_hash: HASH,
    source_through_time: TIME, source_requested_version: '3' };
  const input = { requestedVersion: '3', eventThroughBlock: '110',
    observationFromBlock: '101',
    observationFromHash: HASH, observationFromTime: TIME, sourceThroughBlock: '120',
    sourceThroughHash: HASH, sourceThroughTime: TIME,
    snapshot: { state: { throughBlockNumber: '120', throughBlockHash: HASH } } };
  assert.equal(assertedLineage(row, input), row);
  assert.throws(() => assertedLineage(row, { ...input, sourceThroughBlock: '121' }),
    /frozen frontier does not match/);
  assert.throws(() => assertedLineage({ ...row, source_through_time: null }, input),
    (error) => error.code === 'redistribution_anchor_missing');
});
