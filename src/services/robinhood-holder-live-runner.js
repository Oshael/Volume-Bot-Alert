function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function rememberHolderCountUpdate(updates, applied) {
  if (applied.publication) {
    updates.set(applied.publication.tokenAddress, applied.publication);
  }
}

async function publishCountUpdates(publish, updates) {
  if (updates.size === 0) return 0;
  return Number(await publish([...updates.values()])) || 0;
}

function createRobinhoodHolderLiveRunner(options = {}) {
  const capture = options.capture;
  const handoff = options.handoff;
  const ledger = options.ledger;
  const publishHolderCounts = typeof options.publishHolderCounts === 'function'
    ? options.publishHolderCounts : async () => 0;
  if (typeof capture?.captureOnce !== 'function') {
    throw new TypeError('holder live capture is required');
  }
  if (typeof handoff?.runOnce !== 'function') {
    throw new TypeError('holder live handoff is required');
  }
  if (typeof ledger?.applyNextPendingEvent !== 'function') {
    throw new TypeError('holder live ledger is required');
  }

  async function runOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const maxApplyEvents = boundedInteger(
      input.maxApplyEvents, 5000, 1, 50_000, 'maxApplyEvents'
    );
    const captured = await capture.captureOnce({ rangeSize, confirmations });
    if (captured.status === 'reorg-unrecoverable') {
      return Object.freeze({
        status: 'blocked', captureStatus: captured.status,
        reason: captured.reason, checkpointBlock: captured.checkpointBlock,
        journalFloorBlock: captured.journalFloorBlock,
        checkedCheckpoints: captured.checkedCheckpoints,
        handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
        appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
        holderCountUpdates: 0, holderCountPublished: 0,
        applyBudgetExhausted: false,
      });
    }
    if (captured.status === 'reorg-rewound') {
      return Object.freeze({
        status: 'recovered', captureStatus: captured.status,
        canonicalCheckpointBlock: captured.canonicalCheckpointBlock,
        orphanedCheckpointBlock: captured.orphanedCheckpointBlock,
        revertedEvents: Number(captured.revertedEvents) || 0,
        resyncingTokens: Number(captured.resyncingTokens) || 0,
        handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
        appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
        holderCountUpdates: 0, holderCountPublished: 0,
        applyBudgetExhausted: false,
      });
    }
    if (!['captured', 'idle'].includes(captured.status)) {
      const error = new Error(`unexpected holder capture status: ${captured.status}`);
      error.code = 'holder_live_capture_contract_error';
      throw error;
    }
    const handedOff = await handoff.runOnce();
    const handoffStatus = handedOff?.status;
    if (!['idle', 'shadow', 'resyncing'].includes(handoffStatus)) {
      const error = new Error(`unexpected holder handoff status: ${handoffStatus}`);
      error.code = 'holder_live_handoff_contract_error';
      throw error;
    }

    let appliedEvents = 0;
    let driftedTokens = 0;
    let applyAttempts = 0;
    let reachedIdle = false;
    const holderCountUpdates = new Map();
    while (applyAttempts < maxApplyEvents) {
      const applied = await ledger.applyNextPendingEvent();
      if (applied.status === 'idle') {
        reachedIdle = true;
        break;
      }
      applyAttempts += 1;
      if (applied.status === 'applied') {
        appliedEvents += 1;
        rememberHolderCountUpdate(holderCountUpdates, applied);
      } else if (applied.status === 'drifted') driftedTokens += 1;
      else {
        const error = new Error(`unexpected holder apply status: ${applied.status}`);
        error.code = 'holder_live_apply_contract_error';
        throw error;
      }
    }
    const holderCountPublished = await publishCountUpdates(
      publishHolderCounts, holderCountUpdates
    );
    return Object.freeze({
      status: 'completed', captureStatus: captured.status,
      capturedTransfers: Number(captured.transfers) || 0,
      handoffStatus,
      handoffPromotions: handoffStatus === 'shadow' ? 1 : 0,
      handoffResyncs: handoffStatus === 'resyncing' ? 1 : 0,
      appliedEvents, driftedTokens, applyAttempts,
      holderCountUpdates: holderCountUpdates.size, holderCountPublished,
      applyBudgetExhausted: !reachedIdle && applyAttempts === maxApplyEvents,
      nextBlock: captured.nextBlock, safeHead: captured.safeHead,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = { createRobinhoodHolderLiveRunner };
