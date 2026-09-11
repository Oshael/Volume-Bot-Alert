'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  backoffFor, createRobinhoodWalletSwapRealtimePublisherRunner,
} = require('../src/services/robinhood-wallet-swap-realtime-publisher-runner');
const {
  createRobinhoodWalletSwapRealtimeOutboxRepository,
} = require('../src/models/robinhood-wallet-swap-realtime-outbox');

const row = {
  transactionHash: `0x${'1'.repeat(64)}`, logIndex: '7',
  blockHash: `0x${'2'.repeat(64)}`, eventKind: 'observed',
  attemptCount: 2, payload: { type: 'market:trade:observed' },
};

function fixture(publishRows) {
  let settlement;
  const repository = {
    reclaimExpiredPublicationLeases: async () => 1,
    claimPublication: async (input) => {
      assert.equal(input.observedEnabled, true);
      assert.equal(input.activationBlock, '100');
      return [row];
    },
    settlePublication: async (input) => {
      settlement = input;
      return {
        delivered: input.delivered.length, retried: input.retry.length, blocked: 0,
      };
    },
  };
  const runner = createRobinhoodWalletSwapRealtimePublisherRunner({
    repository, publishRows,
    options: { owner: 'publisher-test', baseBackoffMs: 1000 },
  });
  return { getSettlement: () => settlement, runner };
}

describe('Robinhood wallet-swap realtime publisher', () => {
  it('does not scan historical publication work before the first activation', async () => {
    let queries = 0;
    const repository = createRobinhoodWalletSwapRealtimeOutboxRepository({
      database: {
        query: async () => {
          queries += 1;
          return { rows: [] };
        },
      },
    });
    assert.deepEqual(await repository.claimPublication({
      owner: 'publisher-test', limit: 200, leaseMs: 60000, observedEnabled: false,
    }), []);
    assert.equal(queries, 0);
  });

  it('settles only after the durable relay accepts the batch', async () => {
    const state = fixture(async (payloads) => {
      assert.deepEqual(payloads, [row.payload]);
      return true;
    });
    assert.deepEqual(await state.runner.runOnce({
      observedEnabled: true, activationBlock: '100',
    }), {
      status: 'delivered', observedEnabled: true, activationBlock: '100', reclaimed: 1,
      claimed: 1, delivered: 1, retried: 0, blocked: 0,
    });
    assert.deepEqual(state.getSettlement().delivered, [row]);
  });

  it('retries a rejected transport batch with bounded backoff', async () => {
    const state = fixture(async () => false);
    const result = await state.runner.runOnce({
      observedEnabled: true, activationBlock: '100',
    });
    assert.equal(result.status, 'retrying');
    assert.equal(state.getSettlement().delivered.length, 0);
    assert.equal(state.getSettlement().retry[0].backoffMs, backoffFor(2, 1000, 300000));
  });
});
