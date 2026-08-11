const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLiveRunner,
} = require('../src/services/robinhood-holder-live-runner');

function harness(
  captureResult, applyResults = [], handoffResult = { status: 'idle' },
  publishHolderCounts = async () => 0, options = {}
) {
  const calls = [];
  const capture = {
    captureOnce: async (input) => {
      calls.push(['capture', input]);
      return captureResult;
    },
  };
  const ledger = {
    applyNextPendingEvent: async (input) => {
      calls.push(input ? ['apply', input] : ['apply']);
      return applyResults.shift() || { status: 'idle' };
    },
    repairCapturedRange: async (range) => {
      calls.push(['repair', range]);
      return options.repairResults?.shift() || {
        status: 'repaired', insertedTransfers: 0, duplicateTransfers: 0,
      };
    },
  };
  const reader = {
    readReceiptRange: async (input) => {
      calls.push(['receipts', input]);
      return { ...input, checkpoint: { number: input.toBlock, hash: `0x${'a'.repeat(64)}` },
        transfers: [] };
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
    runner: createRobinhoodHolderLiveRunner({
      capture, handoff, ledger, reader, publishHolderCounts,
      now: options.now, driftRecheckMs: options.driftRecheckMs,
    }),
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
      driftSuspicions: 0, receiptRecoveries: 0, driftDeferred: 0,
      holderCountUpdates: 0, holderCountPublished: 0,
      applyBudgetExhausted: false, nextBlock: '106', safeHead: '105',
    });
    assert.deepEqual(context.calls, [
      ['capture', { rangeSize: 100, confirmations: 20 }],
      ['handoff'],
      ['apply'], ['apply'], ['apply'], ['apply'],
    ]);
  });

  it('repairs a missing live-tail transfer from receipts before retrying application', async () => {
    const suspicion = {
      status: 'drift-suspected', tokenAddress: `0x${'1'.repeat(40)}`,
      fingerprint: 'deficit', failedBlock: '105', recoveryFromBlock: '103',
      recoverySafe: true,
    };
    const context = harness({
      status: 'captured', transfers: 1, nextBlock: '106', safeHead: '105',
    }, [suspicion, { status: 'applied' }, { status: 'idle' }], { status: 'idle' },
    async () => 0, { repairResults: [{ status: 'repaired', insertedTransfers: 1 }] });

    const result = await context.runner.runOnce();

    assert.equal(result.driftedTokens, 0);
    assert.equal(result.driftSuspicions, 1);
    assert.equal(result.receiptRecoveries, 1);
    assert.equal(context.calls.filter(([name]) => name === 'receipts').length, 1);
    assert.equal(context.calls.filter(([name]) => name === 'apply').length, 3);
  });

  it('isolates only after three spaced receipt-confirmed live deficits', async () => {
    let nowMs = Date.parse('2026-08-11T00:00:00.000Z');
    const suspicion = {
      status: 'drift-suspected', tokenAddress: `0x${'1'.repeat(40)}`,
      fingerprint: 'persistent-deficit', failedBlock: '105', recoveryFromBlock: '103',
      recoverySafe: true,
    };
    const context = harness({
      status: 'captured', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [
      suspicion, { status: 'idle' },
      suspicion, { status: 'idle' },
      suspicion, { status: 'drifted' }, { status: 'idle' },
    ],
    { status: 'idle' }, async () => 0, {
      now: () => nowMs, driftRecheckMs: 60_000,
      repairResults: Array.from({ length: 3 }, () => ({
        status: 'repaired', insertedTransfers: 0, duplicateTransfers: 1,
      })),
    });

    assert.equal((await context.runner.runOnce()).driftedTokens, 0);
    nowMs += 60_000;
    assert.equal((await context.runner.runOnce()).driftedTokens, 0);
    nowMs += 60_000;
    assert.equal((await context.runner.runOnce()).driftedTokens, 1);
    assert.equal(context.calls.filter(([name]) => name === 'receipts').length, 3);
    assert.equal(context.calls.some(([, input]) => (
      input?.confirmDriftFingerprint === 'persistent-deficit'
    )), true);
  });

  it('defers one unrecoverable token without starving other token events', async () => {
    const deferredToken = `0x${'1'.repeat(40)}`;
    const context = harness({
      status: 'captured', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [{
      status: 'drift-suspected', tokenAddress: deferredToken,
      fingerprint: 'wide-deficit', failedBlock: '700', recoveryFromBlock: '100',
      recoverySafe: true,
    }, {
      status: 'applied', tokenAddress: `0x${'2'.repeat(40)}`,
    }, { status: 'idle' }]);

    const result = await context.runner.runOnce();

    assert.equal(result.appliedEvents, 1);
    assert.equal(result.driftDeferred, 1);
    assert.equal(context.calls.some(([, input]) => (
      input?.excludeTokenAddresses?.includes(deferredToken)
    )), true);
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
    const published = [];
    const correction = { tokenAddress: `0x${'a'.repeat(40)}`, holderCount: '9' };
    const invalidation = { tokenAddress: `0x${'b'.repeat(40)}`, invalidated: true };
    const recovered = harness({
      status: 'reorg-rewound', canonicalCheckpointBlock: '95',
      orphanedCheckpointBlock: '100', revertedEvents: 4, resyncingTokens: 1,
      publications: [correction, invalidation],
    }, [], { status: 'idle' }, async (updates) => {
      published.push(updates);
      return updates.length;
    });
    assert.deepEqual(await recovered.runner.runOnce(), {
      status: 'recovered', captureStatus: 'reorg-rewound',
      canonicalCheckpointBlock: '95', orphanedCheckpointBlock: '100',
      revertedEvents: 4, resyncingTokens: 1,
      handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
      appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
      holderCountUpdates: 2, holderCountPublished: 2,
      applyBudgetExhausted: false,
    });
    assert.deepEqual(published, [[correction, invalidation]]);
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
      holderCountUpdates: 0, holderCountPublished: 0,
      applyBudgetExhausted: false,
    });
    assert.equal(blocked.calls.some(([name]) => name === 'apply'), false);
    assert.equal(blocked.calls.some(([name]) => name === 'handoff'), false);
  });

  it('coalesces committed live count changes per token before publishing', async () => {
    const published = [];
    const first = { tokenAddress: `0x${'a'.repeat(40)}`, holderCount: '10' };
    const latest = { ...first, holderCount: '11', ledgerVersion: '2' };
    const other = { tokenAddress: `0x${'b'.repeat(40)}`, holderCount: '4' };
    const context = harness({
      status: 'captured', transfers: 3, nextBlock: '106', safeHead: '105',
    }, [
      { status: 'applied', publication: first },
      { status: 'applied', publication: latest },
      { status: 'applied', publication: other },
      { status: 'idle' },
    ], { status: 'idle' }, async (updates) => {
      published.push(updates);
      return updates.length;
    });

    const result = await context.runner.runOnce();

    assert.deepEqual(published, [[latest, other]]);
    assert.equal(result.holderCountUpdates, 2);
    assert.equal(result.holderCountPublished, 2);
    assert.equal(context.calls.at(-1)[0], 'apply');
  });

  it('propagates relay failure only after the ledger event was committed', async () => {
    const publication = { tokenAddress: `0x${'a'.repeat(40)}`, holderCount: '10' };
    const context = harness({
      status: 'captured', transfers: 1, nextBlock: '106', safeHead: '105',
    }, [
      { status: 'applied', publication }, { status: 'idle' },
    ], { status: 'idle' }, async () => { throw new Error('relay offline'); });

    await assert.rejects(context.runner.runOnce(), /relay offline/);
    assert.equal(context.calls.filter(([name]) => name === 'apply').length, 2);
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
