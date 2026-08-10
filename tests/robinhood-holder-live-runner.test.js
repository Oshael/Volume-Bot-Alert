const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLiveRunner,
} = require('../src/services/robinhood-holder-live-runner');

function harness(captureResult, applyResults = [], handoffResult = { status: 'idle' }) {
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
  const handoff = {
    runOnce: async () => {
      calls.push(['handoff']);
      return handoffResult;
    },
  };
  return {
    calls,
    runner: createRobinhoodHolderLiveRunner({ capture, handoff, ledger }),
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
      handoffStatus: 'idle', handoffPromotions: 0, handoffResyncs: 0,
      appliedEvents: 2, driftedTokens: 1, applyAttempts: 3,
      applyBudgetExhausted: false, nextBlock: '106', safeHead: '105',
    });
    assert.deepEqual(context.calls, [
      ['capture', { rangeSize: 100, confirmations: 20 }],
      ['handoff'],
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
      handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
      appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
      applyBudgetExhausted: false,
    });
    assert.equal(recovered.calls.some(([name]) => name === 'apply'), false);
    assert.equal(recovered.calls.some(([name]) => name === 'handoff'), false);

    const blocked = harness({
      status: 'reorg-unrecoverable', reason: 'canonical-evidence-unavailable',
      checkpointBlock: '100', journalFloorBlock: '90', checkedCheckpoints: 3,
    });
    assert.deepEqual(await blocked.runner.runOnce(), {
      status: 'blocked', captureStatus: 'reorg-unrecoverable',
      reason: 'canonical-evidence-unavailable', checkpointBlock: '100',
      journalFloorBlock: '90', checkedCheckpoints: 3,
      handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
      appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
      applyBudgetExhausted: false,
    });
    assert.equal(blocked.calls.some(([name]) => name === 'apply'), false);
    assert.equal(blocked.calls.some(([name]) => name === 'handoff'), false);
  });

  it('promotes at most one token before applying its preserved tail', async () => {
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [{ status: 'applied' }, { status: 'idle' }], { status: 'shadow' });

    const result = await context.runner.runOnce();

    assert.equal(result.handoffStatus, 'shadow');
    assert.equal(result.handoffPromotions, 1);
    assert.equal(result.handoffResyncs, 0);
    assert.deepEqual(context.calls.map(([name]) => name), [
      'capture', 'handoff', 'apply', 'apply',
    ]);
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

    const handoffContract = harness({ status: 'idle' }, [], { status: 'mystery' });
    await assert.rejects(
      handoffContract.runner.runOnce(),
      (error) => error.code === 'holder_live_handoff_contract_error'
    );
  });
});
