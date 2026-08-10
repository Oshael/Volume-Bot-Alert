const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLiveRunner,
} = require('../src/services/robinhood-holder-live-runner');

function harness(captureResult, applyResults = []) {
  const calls = [];
  const capture = {
    captureOnce: async (input) => {
      calls.push(['capture', input]);
      return captureResult;
    },
  };
  const ledger = {
    applyNextPendingEvent: async () => {
      calls.push(['apply']);
      return applyResults.shift() || { status: 'idle' };
    },
  };
  return {
    calls,
    runner: createRobinhoodHolderLiveRunner({ capture, ledger }),
  };
}

describe('Robinhood holder live runner', () => {
  it('captures one range and drains eligible events within one bounded tick', async () => {
    const context = harness({
      status: 'captured', transfers: 3, nextBlock: '106', safeHead: '105',
    }, [
      { status: 'applied' },
      { status: 'drifted' },
      { status: 'applied' },
      { status: 'idle' },
    ]);

    assert.deepEqual(await context.runner.runOnce({
      rangeSize: 100, confirmations: 20, maxApplyEvents: 10,
    }), {
      status: 'completed', captureStatus: 'captured', capturedTransfers: 3,
      appliedEvents: 2, driftedTokens: 1, applyAttempts: 3,
      applyBudgetExhausted: false, nextBlock: '106', safeHead: '105',
    });
    assert.deepEqual(context.calls, [
      ['capture', { rangeSize: 100, confirmations: 20 }],
      ['apply'], ['apply'], ['apply'], ['apply'],
    ]);
  });

  it('stops exactly at the apply budget without starting another capture', async () => {
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }]);

    const result = await context.runner.runOnce({ maxApplyEvents: 2 });

    assert.equal(result.applyAttempts, 2);
    assert.equal(result.appliedEvents, 2);
    assert.equal(result.applyBudgetExhausted, true);
    assert.equal(context.calls.filter(([name]) => name === 'capture').length, 1);
  });

  it('does not apply events during recovery or without canonical evidence', async () => {
    const recovered = harness({
      status: 'reorg-rewound', canonicalCheckpointBlock: '95',
      orphanedCheckpointBlock: '100', revertedEvents: 4, resyncingTokens: 1,
    });
    assert.deepEqual(await recovered.runner.runOnce(), {
      status: 'recovered', captureStatus: 'reorg-rewound',
      canonicalCheckpointBlock: '95', orphanedCheckpointBlock: '100',
      revertedEvents: 4, resyncingTokens: 1,
      appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
      applyBudgetExhausted: false,
    });
    assert.equal(recovered.calls.some(([name]) => name === 'apply'), false);

    const blocked = harness({
      status: 'reorg-unrecoverable', reason: 'canonical-evidence-unavailable',
      checkpointBlock: '100', journalFloorBlock: '90', checkedCheckpoints: 3,
    });
    assert.deepEqual(await blocked.runner.runOnce(), {
      status: 'blocked', captureStatus: 'reorg-unrecoverable',
      reason: 'canonical-evidence-unavailable', checkpointBlock: '100',
      journalFloorBlock: '90', checkedCheckpoints: 3,
      appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
      applyBudgetExhausted: false,
    });
    assert.equal(blocked.calls.some(([name]) => name === 'apply'), false);
  });

  it('fails closed on an unknown dependency status', async () => {
    const captureContract = harness({ status: 'mystery' });
    await assert.rejects(
      captureContract.runner.runOnce(),
      (error) => error.code === 'holder_live_capture_contract_error'
    );

    const applyContract = harness({ status: 'idle' }, [{ status: 'mystery' }]);
    await assert.rejects(
      applyContract.runner.runOnce(),
      (error) => error.code === 'holder_live_apply_contract_error'
    );
  });
});
