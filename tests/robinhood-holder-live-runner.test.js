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
    listHotPendingTokenAddresses: async (input) => {
      if (!options.hotTokenLists?.length) return [];
      calls.push(['list-hot-tokens', input]);
      return options.hotTokenLists.shift();
    },
    getHotQueueFreshness: async () => options.freshness || {
      pendingTokens: 0, worstLagBlocks: 0, oldestAgeMs: 0,
    },
    listPendingTokenAddresses: async (input) => {
      calls.push(['list-pending-tokens', input]);
      if (options.pendingTokenLists?.length) return options.pendingTokenLists.shift();
      const next = applyResults[0];
      const tokenAddress = next?.tokenAddress || `0x${'f'.repeat(40)}`;
      return next && next.status !== 'idle'
        && !input.excludeTokenAddresses?.includes(tokenAddress) ? [tokenAddress] : [];
    },
    applyNextPendingEvent: async (input) => {
      calls.push(input ? ['apply', input] : ['apply']);
      const result = applyResults.shift();
      if (result instanceof Error) throw result;
      return result || { status: 'idle' };
    },
    repairCapturedRange: async (range) => {
      calls.push(['repair', range]);
      return options.repairResults?.shift() || {
        status: 'repaired', insertedTransfers: 0, duplicateTransfers: 0,
      };
    },
    rollbackAppliedTail: async (input) => {
      calls.push(['rollback-tail', input]);
      const result = options.rollbackResults?.shift();
      if (result instanceof Error) throw result;
      return result || {
        status: 'requeued', tokenAddress: input.tokenAddress, revertedEvents: 1,
      };
    },
    requeueWideShadowTail: async (input) => {
      calls.push(['requeue-wide-tail', input]);
      return options.requeueResults?.shift() || {
        status: 'not-requeued', reason: 'state-not-safe',
      };
    },
    quarantineMalformedToken: async (input) => {
      calls.push(['quarantine', input]);
      return {
        status: 'quarantined', tokenAddress: input.tokenAddress,
        deletedBalances: 1, deletedJournalEvents: 2,
      };
    },
    promoteReadyShadowTokens: async (input) => {
      calls.push(['promote-shadows', input]);
      if (options.shadowPromotion instanceof Error) throw options.shadowPromotion;
      if (input.tokenAddress) {
        return options.targetedShadowPromotions?.shift() || {
          status: 'idle', promotedTokens: 0, publications: [],
        };
      }
      return options.shadowPromotion || {
        status: 'idle', promotedTokens: 0, publications: [],
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
      measureNow: options.measureNow,
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

    const { timing, ...result } = await context.runner.runOnce({
      rangeSize: 100, confirmations: 20, maxApplyEvents: 10,
      admittedAfter: '2026-08-20T06:27:49.580Z',
      seedLimit: 25, maxInitialGapBlocks: 20_000,
    });
    assert.deepEqual(result, {
      status: 'completed', captureStatus: 'captured', capturedTransfers: 3,
      handoffStatus: 'idle', handoffPromotions: 0, handoffResyncs: 0,
      appliedEvents: 2, driftedTokens: 1, applyAttempts: 3,
      driftSuspicions: 0, receiptRecoveries: 0, driftDeferred: 0,
      tailRollbacks: 0, tailRollbackEvents: 0,
      baselineRequeues: 0,
      quarantinedTokens: 0,
      shadowPromotions: 0,
      holderCountUpdates: 0, holderCountPublished: 0,
      freshness: { pendingTokens: 0, worstLagBlocks: 0, oldestAgeMs: 0 },
      applyBudgetExhausted: false, nextBlock: '106', safeHead: '105',
    });
    assert.equal(timing.applyCalls, 3);
    assert.equal(timing.nonIdleApplyCalls, 3);
    assert.equal(timing.averageAttemptedEventsPerNonIdleCall, 1);
    assert.equal(timing.maxAttemptedEventsPerCall, 1);
    assert.equal(timing.configuredBatchSize, 100);
    for (const key of [
      'totalDurationMs', 'drainDurationMs', 'applyCallDurationMs',
      'maxApplyCallDurationMs', 'driftRepairDurationMs',
      'selectionDurationMs',
      'drainOverheadDurationMs', 'shadowPromotionDurationMs',
      'publicationDurationMs', 'appliedEventsPerSecond',
    ]) assert.equal(Number.isFinite(timing[key]), true, key);
    assert.deepEqual(context.calls, [
      ['capture', {
        rangeSize: 100, confirmations: 20,
        admittedAfter: '2026-08-20T06:27:49.580Z',
        seedLimit: 25, maxInitialGapBlocks: 20_000,
      }],
      ['handoff'],
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 10 }],
      ['apply', { onlyTokenAddress: `0x${'f'.repeat(40)}`, maxEvents: 10 }],
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 9 }],
      ['apply', { onlyTokenAddress: `0x${'f'.repeat(40)}`, maxEvents: 9 }],
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 8 }],
      ['apply', { onlyTokenAddress: `0x${'f'.repeat(40)}`, maxEvents: 8 }],
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 7 }],
      ['promote-shadows', { limit: 10 }],
    ]);
  });

  it('reports a malformed-token quarantine as recovery without advancing or applying', async () => {
    const tokenAddress = `0x${'7'.repeat(40)}`;
    const context = harness({
      status: 'malformed-token-quarantined', tokenAddress,
      nextBlock: '103', safeHead: '105', deletedBalances: 4, deletedJournalEvents: 6,
    });

    assert.deepEqual(await context.runner.runOnce(), {
      status: 'recovered', captureStatus: 'malformed-token-quarantined',
      quarantinedTokenAddress: tokenAddress, quarantinedTokens: 1,
      deletedBalances: 4, deletedJournalEvents: 6,
      nextBlock: '103', safeHead: '105',
      handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
      appliedEvents: 0, driftedTokens: 1, applyAttempts: 0,
      holderCountUpdates: 0, holderCountPublished: 0,
      applyBudgetExhausted: false,
    });
    assert.equal(context.calls.some(([name]) => name === 'handoff' || name === 'apply'), false);
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
    assert.equal(context.calls.filter(([name]) => name === 'apply').length, 2);
  });

  it('rolls back an applied tail and invalidates a previously live token', async () => {
    const tokenAddress = `0x${'1'.repeat(40)}`;
    const failedTransactionHash = `0x${'b'.repeat(64)}`;
    const publication = { tokenAddress, invalidated: true, ledgerVersion: '9' };
    const published = [];
    const suspicion = {
      status: 'drift-suspected', tokenAddress, fingerprint: 'unsafe-tail',
      failedBlock: '110', failedTransactionHash, failedLogIndex: 3,
      recoveryFromBlock: '100', recoverySafe: false,
    };
    const context = harness({
      status: 'captured', transfers: 1, nextBlock: '111', safeHead: '110',
    }, [suspicion, { status: 'idle' }], { status: 'idle' }, async (updates) => {
      published.push(updates);
      return updates.length;
    }, { rollbackResults: [{
      status: 'requeued', tokenAddress, revertedEvents: 7, publication,
    }] });

    const result = await context.runner.runOnce();

    assert.equal(result.tailRollbacks, 1);
    assert.equal(result.tailRollbackEvents, 7);
    assert.equal(result.driftDeferred, 0);
    assert.equal(context.calls.filter(([name]) => name === 'apply').length, 1);
    assert.deepEqual(published, [[publication]]);
    assert.deepEqual(context.calls.find(([name]) => name === 'rollback-tail'), [
      'rollback-tail', {
        tokenAddress, backfillNextBlock: '100', failedBlock: '110',
        failedTransactionHash, failedLogIndex: 3,
      },
    ]);
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
      suspicion, suspicion, suspicion, { status: 'drifted' },
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

  it('isolates a stable unsafe tail without evidence instead of stopping the drain', async () => {
    let nowMs = Date.parse('2026-08-21T00:00:00.000Z');
    const tokenAddress = `0x${'1'.repeat(40)}`;
    const suspicion = {
      status: 'drift-suspected', tokenAddress, fingerprint: 'missing-tail-evidence',
      failedBlock: '110', failedTransactionHash: `0x${'b'.repeat(64)}`,
      failedLogIndex: 3, recoveryFromBlock: '100', recoverySafe: false,
    };
    const unavailable = () => Object.assign(
      new Error('holder tail rollback has no applied evidence'),
      { code: 'holder_tail_rollback_unavailable' }
    );
    const context = harness({
      status: 'captured', transfers: 0, nextBlock: '111', safeHead: '110',
    }, [
      suspicion, { status: 'applied', tokenAddress: `0x${'2'.repeat(40)}` },
      suspicion, suspicion, { status: 'drifted', tokenAddress }, { status: 'idle' },
    ], { status: 'idle' }, async () => 0, {
      now: () => nowMs, driftRecheckMs: 60_000,
      rollbackResults: [unavailable(), unavailable(), unavailable()],
    });

    const first = await context.runner.runOnce({ maxApplyEvents: 2 });
    assert.equal(first.appliedEvents, 1);
    assert.equal(first.driftedTokens, 0);
    nowMs += 60_000;
    assert.equal((await context.runner.runOnce({ maxApplyEvents: 1 })).driftedTokens, 0);
    nowMs += 60_000;
    assert.equal((await context.runner.runOnce()).driftedTokens, 1);
    assert.equal(context.calls.filter(([name]) => name === 'rollback-tail').length, 3);
    assert.equal(context.calls.some(([, input]) => (
      input?.confirmDriftFingerprint === 'missing-tail-evidence'
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

  it('requeues a safe wide shadow tail for baseline backfill', async () => {
    const tokenAddress = `0x${'1'.repeat(40)}`;
    const failedTransactionHash = `0x${'b'.repeat(64)}`;
    const suspicion = {
      status: 'drift-suspected', tokenAddress, fingerprint: 'wide-deficit',
      failedBlock: '700', failedTransactionHash, failedLogIndex: 3,
      recoveryFromBlock: '100', recoverySafe: true,
    };
    const context = harness({
      status: 'captured', transfers: 0, nextBlock: '701', safeHead: '700',
    }, [suspicion, { status: 'idle' }], { status: 'idle' }, async () => 0, {
      requeueResults: [{
        status: 'requeued', recovery: 'wide-shadow-tail', tokenAddress,
        backfillNextBlock: '100', receiptBlocks: '601', revertedEvents: 0,
      }],
    });

    const result = await context.runner.runOnce();

    assert.equal(result.baselineRequeues, 1);
    assert.equal(result.tailRollbacks, 0);
    assert.equal(result.driftDeferred, 0);
    assert.deepEqual(context.calls.find(([name]) => name === 'requeue-wide-tail'), [
      'requeue-wide-tail', {
        tokenAddress, backfillNextBlock: '100', failedBlock: '700',
        failedTransactionHash, failedLogIndex: 3, receiptBlockLimit: 250,
      },
    ]);
  });

  it('keeps draining one token before returning to the global pending order', async () => {
    const tokenA = `0x${'a'.repeat(40)}`;
    const tokenB = `0x${'b'.repeat(40)}`;
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [
      { status: 'applied', tokenAddress: tokenA },
      { status: 'applied', tokenAddress: tokenA },
      { status: 'idle' },
      { status: 'applied', tokenAddress: tokenB },
      { status: 'idle' },
      { status: 'idle' },
    ]);

    const result = await context.runner.applyOnce({
      maxApplyEvents: 10, applyBatchSize: 1,
    });

    assert.equal(result.appliedEvents, 3);
    assert.equal(result.applyBudgetExhausted, false);
    assert.deepEqual(context.calls, [
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 10 }],
      ['apply', { onlyTokenAddress: tokenA, maxEvents: 1 }],
      ['apply', { onlyTokenAddress: tokenA, maxEvents: 1 }],
      ['apply', { onlyTokenAddress: tokenA, maxEvents: 1 }],
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 8 }],
      ['apply', { onlyTokenAddress: tokenB, maxEvents: 1 }],
      ['apply', { onlyTokenAddress: tokenB, maxEvents: 1 }],
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 7 }],
      ['promote-shadows', { limit: 10 }],
    ]);
  });

  it('rotates one batch per token before giving the sole remaining token full capacity', async () => {
    const tokenA = `0x${'a'.repeat(40)}`;
    const tokenB = `0x${'b'.repeat(40)}`;
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [
      { status: 'applied', tokenAddress: tokenA },
      { status: 'applied', tokenAddress: tokenB },
      { status: 'applied', tokenAddress: tokenA },
      { status: 'applied', tokenAddress: tokenA },
    ], { status: 'idle' }, async () => 0, {
      pendingTokenLists: [[tokenA, tokenB], [tokenA]],
    });

    const result = await context.runner.applyOnce({
      maxApplyEvents: 4, applyBatchSize: 1,
    });

    assert.equal(result.appliedEvents, 4);
    assert.equal(result.applyBudgetExhausted, true);
    assert.deepEqual(context.calls.filter(([name]) => name === 'apply').map(
      ([, input]) => input.onlyTokenAddress
    ), [tokenA, tokenB, tokenA, tokenA]);
    assert.equal(context.calls.filter(([name]) => name === 'list-pending-tokens').length, 2);
  });

  it('preempts catch-up with a bounded hot token batch and reports freshness', async () => {
    const hotToken = `0x${'1'.repeat(40)}`;
    const coldToken = `0x${'2'.repeat(40)}`;
    const freshness = { pendingTokens: 2, worstLagBlocks: 3, oldestAgeMs: 450 };
    const context = harness({ status: 'idle', transfers: 0 }, [
      { status: 'applied', tokenAddress: hotToken, appliedEvents: 10, attemptedEvents: 10 },
      { status: 'applied', tokenAddress: coldToken, appliedEvents: 1, attemptedEvents: 1 },
      { status: 'idle' },
    ], { status: 'idle' }, async () => 0, {
      hotTokenLists: [[hotToken]], freshness,
    });

    const result = await context.runner.applyOnce({
      maxApplyEvents: 20, applyBatchSize: 20, hotApplyBatchSize: 10,
    });

    assert.equal(context.calls.find(([name]) => name === 'apply')[1].maxEvents, 10);
    assert.deepEqual(result.freshness, freshness);
  });

  it('accounts for a transactional event batch against the apply budget', async () => {
    const tokenAddress = `0x${'a'.repeat(40)}`;
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [{
      status: 'applied', tokenAddress, holderCount: '40',
      appliedEvents: 100, attemptedEvents: 100,
    }, { status: 'idle', appliedEvents: 0, attemptedEvents: 0 }]);

    const result = await context.runner.applyOnce({
      maxApplyEvents: 250, applyBatchSize: 100,
    });

    assert.equal(result.appliedEvents, 100);
    assert.equal(result.applyAttempts, 100);
    assert.equal(result.applyBudgetExhausted, false);
    assert.equal(result.timing.applyCalls, 2);
    assert.equal(result.timing.nonIdleApplyCalls, 1);
    assert.equal(result.timing.averageAttemptedEventsPerNonIdleCall, 100);
    assert.equal(result.timing.maxAttemptedEventsPerCall, 100);
    assert.deepEqual(context.calls.slice(0, 2), [
      ['list-pending-tokens', { excludeTokenAddresses: [], limit: 250 }],
      ['apply', { onlyTokenAddress: tokenAddress, maxEvents: 100 }],
    ]);
  });

  it('annotates apply failures with the selected token and stage', async () => {
    const tokenAddress = `0x${'a'.repeat(40)}`;
    const failure = Object.assign(new Error('numeric field overflow'), { code: '22003' });
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [Object.assign(failure, { tokenAddress })]);

    await assert.rejects(context.runner.applyOnce(), (error) => {
      assert.equal(error, failure);
      assert.equal(error.holderStage, 'apply');
      assert.equal(error.holderTokenAddress, tokenAddress);
      return true;
    });
  });

  it('quarantines a uint256 overflow and continues draining other tokens', async () => {
    const badToken = `0x${'a'.repeat(40)}`;
    const goodToken = `0x${'b'.repeat(40)}`;
    const overflow = Object.assign(new Error('projected holder balance exceeds uint256'), {
      code: 'holder_balance_overflow', tokenAddress: badToken,
    });
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [overflow, { status: 'applied', tokenAddress: goodToken }, { status: 'idle' }]);

    const result = await context.runner.applyOnce({ maxApplyEvents: 5, applyBatchSize: 5 });

    assert.equal(result.quarantinedTokens, 1);
    assert.equal(result.driftedTokens, 1);
    assert.equal(result.appliedEvents, 1);
    assert.deepEqual(context.calls.find(([name]) => name === 'quarantine'), [
      'quarantine', { tokenAddress: badToken, exclusionReason: 'balance_overflow_live' },
    ]);
  });

  it('annotates shadow-promotion failures without inventing a token', async () => {
    const failure = Object.assign(new Error('numeric field overflow'), { code: '22003' });
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '106', safeHead: '105',
    }, [{ status: 'idle' }], { status: 'idle' }, async () => 0, {
      shadowPromotion: failure,
    });

    await assert.rejects(context.runner.applyOnce(), (error) => {
      assert.equal(error.holderStage, 'shadow_promotion');
      assert.equal(error.holderTokenAddress, undefined);
      return true;
    });
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

  it('allows capture to advance while an independent apply tick is in flight', async () => {
    let releaseApply;
    const applyGate = new Promise((resolve) => { releaseApply = resolve; });
    const context = harness({
      status: 'captured', transfers: 2, nextBlock: '108', safeHead: '107',
    }, [{ status: 'applied' }]);
    context.runner = createRobinhoodHolderLiveRunner({
      capture: {
        captureOnce: async () => ({
          status: 'captured', transfers: 2, nextBlock: '108', safeHead: '107',
        }),
      },
      handoff: { runOnce: async () => ({ status: 'idle' }) },
      ledger: {
        listHotPendingTokenAddresses: async () => [],
        getHotQueueFreshness: async () => ({
          pendingTokens: 0, worstLagBlocks: 0, oldestAgeMs: 0,
        }),
        listPendingTokenAddresses: async () => [`0x${'a'.repeat(40)}`],
        applyNextPendingEvent: async () => {
          await applyGate;
          return { status: 'applied' };
        },
        repairCapturedRange: async () => ({ status: 'repaired', insertedTransfers: 0 }),
        requeueWideShadowTail: async () => ({ status: 'not-requeued' }),
        rollbackAppliedTail: async () => ({ status: 'requeued', revertedEvents: 0 }),
        quarantineMalformedToken: async () => ({
          status: 'quarantined', tokenAddress: `0x${'a'.repeat(40)}`,
        }),
        promoteReadyShadowTokens: async () => ({
          status: 'idle', promotedTokens: 0, publications: [],
        }),
      },
      reader: { readReceiptRange: async () => ({ transfers: [] }) },
    });

    const applying = context.runner.applyOnce({ maxApplyEvents: 1 });
    const captured = await context.runner.captureOnce();
    assert.equal(captured.nextBlock, '108');
    releaseApply();
    assert.equal((await applying).applyBudgetExhausted, true);
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

  it('publishes each committed live batch without waiting for the drain to finish', async () => {
    const published = [];
    const first = { tokenAddress: `0x${'a'.repeat(40)}`, holderCount: '10' };
    const latest = { ...first, holderCount: '11', ledgerVersion: '2' };
    const other = { tokenAddress: `0x${'b'.repeat(40)}`, holderCount: '4' };
    const applyResults = [
      { status: 'applied', publication: first },
      { status: 'applied', publication: latest },
      { status: 'applied', publication: other },
      { status: 'idle' },
    ];
    const context = harness({
      status: 'captured', transfers: 3, nextBlock: '106', safeHead: '105',
    }, applyResults, { status: 'idle' }, async (updates) => {
      assert.equal(applyResults.length > 0, true);
      published.push(updates);
      return updates.length;
    });

    const result = await context.runner.runOnce();

    assert.deepEqual(published, [[first], [latest], [other]]);
    assert.equal(result.holderCountUpdates, 2);
    assert.equal(result.holderCountPublished, 3);
    assert.equal(context.calls.at(-1)[0], 'promote-shadows');
  });

  it('promotes and publishes a newly drained shadow token immediately', async () => {
    const tokenAddress = `0x${'c'.repeat(40)}`;
    const publication = {
      tokenAddress, holderCount: '17', ledgerVersion: '4',
      observedAt: '2026-08-30T10:00:00.000Z', liveThroughBlock: '200',
      liveThroughHash: `0x${'d'.repeat(64)}`,
    };
    const published = [];
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '201', safeHead: '200',
    }, [{
      status: 'applied', tokenAddress, appliedEvents: 3, attemptedEvents: 3,
      tokenDrained: true,
    }, { status: 'idle' }], { status: 'idle' }, async (updates) => {
      published.push(updates);
      return updates.length;
    }, { targetedShadowPromotions: [{
      status: 'promoted', promotedTokens: 1, publications: [publication],
    }] });

    const result = await context.runner.applyOnce({
      maxApplyEvents: 10, applyBatchSize: 10,
    });

    assert.equal(result.shadowPromotions, 1);
    assert.equal(result.holderCountPublished, 1);
    assert.deepEqual(published, [[publication]]);
    assert.deepEqual(context.calls.find(([name, input]) => (
      name === 'promote-shadows' && input.tokenAddress
    )), ['promote-shadows', { limit: 1, tokenAddress }]);
  });

  it('publishes locally verified shadow promotions without Blockscout', async () => {
    const publication = {
      tokenAddress: `0x${'c'.repeat(40)}`, holderCount: '17', ledgerVersion: '4',
      observedAt: '2026-08-20T20:00:00.000Z', liveThroughBlock: '200',
      liveThroughHash: `0x${'d'.repeat(64)}`,
    };
    const published = [];
    const context = harness({
      status: 'idle', transfers: 0, nextBlock: '201', safeHead: '200',
    }, [{ status: 'idle' }], { status: 'idle' }, async (updates) => {
      published.push(updates);
      return updates.length;
    }, { shadowPromotion: {
      status: 'promoted', promotedTokens: 1, publications: [publication],
    } });

    const result = await context.runner.applyOnce({ maxApplyEvents: 50 });

    assert.equal(result.shadowPromotions, 1);
    assert.equal(result.holderCountPublished, 1);
    assert.deepEqual(published, [[publication]]);
  });

  it('propagates relay failure only after the ledger event was committed', async () => {
    const publication = { tokenAddress: `0x${'a'.repeat(40)}`, holderCount: '10' };
    const context = harness({
      status: 'captured', transfers: 1, nextBlock: '106', safeHead: '105',
    }, [
      { status: 'applied', publication }, { status: 'idle' },
    ], { status: 'idle' }, async () => { throw new Error('relay offline'); });

    await assert.rejects(context.runner.runOnce(), (error) => {
      assert.match(error.message, /relay offline/);
      assert.equal(error.holderStage, 'holder_publication');
      return true;
    });
    assert.equal(context.calls.filter(([name]) => name === 'apply').length, 1);
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
      'capture', 'handoff', 'list-pending-tokens', 'apply',
      'list-pending-tokens', 'promote-shadows',
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
