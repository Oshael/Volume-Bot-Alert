'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const v2Fixture = require('../data/fixtures/robinhood-uniswap-v2.json');
const v3Fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const v4Fixture = require('../data/fixtures/robinhood-uniswap-v4.json');
const noxaFixture = require('../data/fixtures/robinhood-noxa-launch.json');
const {
  createRobinhoodCanonicalDiscoveryCapture,
} = require('../src/services/robinhood-canonical-discovery-capture');
const { createRobinhoodCanonicalDiscoveryRunner } = require(
  '../src/services/robinhood-canonical-discovery-runner'
);

function row(log) {
  return {
    transaction_hash: log.transactionHash,
    transaction_index: String(BigInt(log.transactionIndex)),
    log_index: Number(BigInt(log.logIndex)), block_number: String(BigInt(log.blockNumber)),
    block_hash: log.blockHash, block_timestamp: new Date(Number(BigInt(log.blockTimestamp)) * 1000),
    address: log.address, topics: log.topics, data: log.data, attempt_count: 1,
  };
}

describe('canonical Robinhood discovery capture', () => {
  it('rebuilds V2, V3 and V4 evidence without reading logs or timestamps from RPC', async () => {
    const capture = createRobinhoodCanonicalDiscoveryCapture();
    const entries = await capture.buildEntries([
      row(v2Fixture.pairCreated), row(v3Fixture.poolCreated), row(v4Fixture.initialize),
    ]);
    assert.deepEqual(entries.map((entry) => entry.evidence.event.kind), [
      'pair-created', 'pool-created', 'initialize',
    ]);
    assert.deepEqual(entries.map((entry) => entry.protocol), [
      'uniswap-v2', 'uniswap-v3', 'uniswap-v4',
    ]);
    assert.equal(entries[0].log.blockTimestamp, String(BigInt(v2Fixture.pairCreated.blockTimestamp)));
  });

  it('keeps NOXA state validation as explicit local state reads', async () => {
    let context;
    const capture = createRobinhoodCanonicalDiscoveryCapture({
      resolveV3Pool: async () => ({ poolAddress: noxaFixture.expected.pool }),
      noxaValidator: { validateOnchain: async (launch, value) => {
        context = value;
        return { ...launch, accepted: true, marketDiscoveryKey: `robinhood:uniswap-v3:${launch.poolAddress}` };
      } },
    });
    const [entry] = await capture.buildEntries([row(noxaFixture.tokenLaunched)]);
    assert.equal(context.blockTag, String(BigInt(noxaFixture.tokenLaunched.blockNumber)));
    assert.equal(context.v3Pool.poolAddress, noxaFixture.expected.pool);
    assert.equal(entry.evidence.noxa.accepted, true);
    assert.equal(entry.marketKey, `robinhood:uniswap-v3:${noxaFixture.expected.pool}`);
  });

  it('appends before settling durable rows', async () => {
    const calls = [];
    const rows = [row(v2Fixture.pairCreated)];
    const runner = createRobinhoodCanonicalDiscoveryRunner({
      outbox: {
        reclaimExpiredLeases: async () => 0,
        claimReady: async () => rows,
        settle: async (input) => {
          calls.push(input.retry ? 'retry' : 'complete');
          return input.retry
            ? { completed: 0, blocked: 0, retried: 1 }
            : { completed: 1, blocked: 0, retried: 0 };
        },
      },
      capture: { buildEntries: async () => { calls.push('build'); return [{}]; } },
      headRepository: { appendCaptureEntries: async () => {
        calls.push('append'); return { insertedCaptures: 1, duplicateCaptures: 0 };
      } },
    });
    assert.equal((await runner.runOnce()).inserted, 1);
    assert.deepEqual(calls, ['build', 'append', 'complete']);
  });

  it('reschedules a claimed row when evidence construction fails', async () => {
    let settlement;
    const runner = createRobinhoodCanonicalDiscoveryRunner({
      outbox: {
        reclaimExpiredLeases: async () => 0,
        claimReady: async () => [row(v2Fixture.pairCreated)],
        settle: async (input) => {
          settlement = input;
          return { completed: 0, blocked: 0, retried: 1 };
        },
      },
      capture: { buildEntries: async () => { throw new Error('local state unavailable'); } },
      headRepository: { appendCaptureEntries: async () => assert.fail('must not append') },
      options: { baseBackoffMs: 250 },
    });
    const result = await runner.runOnce();
    assert.equal(result.retried, 1);
    assert.equal(settlement.retry[0].backoffMs, 250);
    assert.equal(settlement.retry[0].error.code, 'capture_failed');
  });
});
