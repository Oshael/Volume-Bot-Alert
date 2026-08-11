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

function rewindHolderUpdates(captured) {
  const updates = new Map();
  for (const publication of Array.isArray(captured.publications)
    ? captured.publications : []) {
    if (publication?.tokenAddress) updates.set(publication.tokenAddress, publication);
  }
  return updates;
}

function createRobinhoodHolderLiveRunner(options = {}) {
  const capture = options.capture;
  const handoff = options.handoff;
  const ledger = options.ledger;
  const reader = options.reader;
  const now = options.now || Date.now;
  const driftRecheckMs = boundedInteger(
    options.driftRecheckMs, 60_000, 1000, 600_000, 'driftRecheckMs'
  );
  const receiptBlockLimit = boundedInteger(
    options.receiptBlockLimit, 250, 1, 1000, 'receiptBlockLimit'
  );
  const receiptBatchSize = boundedInteger(
    options.receiptBatchSize, 25, 1, 100, 'receiptBatchSize'
  );
  let driftEvidence = null;
  const publishHolderCounts = typeof options.publishHolderCounts === 'function'
    ? options.publishHolderCounts : async () => 0;
  if (typeof capture?.captureOnce !== 'function') {
    throw new TypeError('holder live capture is required');
  }
  if (typeof handoff?.runOnce !== 'function') {
    throw new TypeError('holder live handoff is required');
  }
  if (typeof ledger?.applyNextPendingEvent !== 'function'
      || typeof ledger?.repairCapturedRange !== 'function') {
    throw new TypeError('holder live ledger is required');
  }
  if (typeof reader?.readReceiptRange !== 'function') {
    throw new TypeError('holder live receipt reader is required');
  }

  function clockMs() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new Error('holder live clock is invalid');
    return value;
  }

  function deferDrift(suspicion) {
    driftEvidence = Object.freeze({
      fingerprint: null, tokenAddress: suspicion.tokenAddress, observations: 0,
      nextObservationAtMs: clockMs() + driftRecheckMs,
    });
  }

  function observeDrift(suspicion) {
    const observations = driftEvidence?.fingerprint === suspicion.fingerprint
      ? driftEvidence.observations + 1 : 1;
    driftEvidence = Object.freeze({
      fingerprint: suspicion.fingerprint, tokenAddress: suspicion.tokenAddress,
      observations, nextObservationAtMs: clockMs() + driftRecheckMs,
    });
    return observations;
  }

  async function repairDrift(suspicion) {
    if (suspicion.recoverySafe !== true || suspicion.recoveryFromBlock == null) {
      return Object.freeze({ status: 'deferred', reason: 'live_tail_already_applied' });
    }
    const blocks = BigInt(suspicion.failedBlock) - BigInt(suspicion.recoveryFromBlock) + 1n;
    if (blocks < 1n || blocks > BigInt(receiptBlockLimit)) {
      return Object.freeze({ status: 'deferred', reason: 'receipt_range_too_wide' });
    }
    try {
      const range = await reader.readReceiptRange({
        tokenAddress: suspicion.tokenAddress, fromBlock: suspicion.recoveryFromBlock,
        toBlock: suspicion.failedBlock, batchSize: receiptBatchSize,
      });
      return ledger.repairCapturedRange(range);
    } catch (error) {
      return Object.freeze({
        status: 'deferred', reason: 'receipt_unavailable',
        error: String(error?.code || error?.message || error).slice(0, 160),
      });
    }
  }

  async function prepareTick(rangeSize, confirmations) {
    const captured = await capture.captureOnce({ rangeSize, confirmations });
    if (captured.status === 'reorg-unrecoverable') {
      return { terminal: Object.freeze({
        status: 'blocked', captureStatus: captured.status,
        reason: captured.reason, checkpointBlock: captured.checkpointBlock,
        journalFloorBlock: captured.journalFloorBlock,
        checkedCheckpoints: captured.checkedCheckpoints,
        handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
        appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
        holderCountUpdates: 0, holderCountPublished: 0,
        applyBudgetExhausted: false,
      }) };
    }
    if (captured.status === 'reorg-rewound') {
      driftEvidence = null;
      const holderCountUpdates = rewindHolderUpdates(captured);
      const holderCountPublished = await publishCountUpdates(
        publishHolderCounts, holderCountUpdates
      );
      return { terminal: Object.freeze({
        status: 'recovered', captureStatus: captured.status,
        canonicalCheckpointBlock: captured.canonicalCheckpointBlock,
        orphanedCheckpointBlock: captured.orphanedCheckpointBlock,
        revertedEvents: Number(captured.revertedEvents) || 0,
        resyncingTokens: Number(captured.resyncingTokens) || 0,
        handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
        appliedEvents: 0, driftedTokens: 0, applyAttempts: 0,
        holderCountUpdates: holderCountUpdates.size, holderCountPublished,
        applyBudgetExhausted: false,
      }) };
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
    return { captured, handoffStatus };
  }

  async function drainPendingEvents(maxApplyEvents) {
    let appliedEvents = 0;
    let driftedTokens = 0;
    let applyAttempts = 0;
    let reachedIdle = false;
    let driftSuspicions = 0;
    let receiptRecoveries = 0;
    let driftDeferred = 0;
    const holderCountUpdates = new Map();
    const waitingForDrift = driftEvidence?.nextObservationAtMs > clockMs();
    if (waitingForDrift) driftDeferred = 1;
    while (!waitingForDrift && applyAttempts < maxApplyEvents) {
      const applied = await ledger.applyNextPendingEvent();
      if (applied.status === 'idle') {
        reachedIdle = true;
        break;
      }
      applyAttempts += 1;
      if (applied.status === 'applied') {
        driftEvidence = null;
        appliedEvents += 1;
        rememberHolderCountUpdate(holderCountUpdates, applied);
      } else if (applied.status === 'drifted') {
        driftedTokens += 1;
        driftEvidence = null;
      } else if (applied.status === 'drift-suspected') {
        driftSuspicions += 1;
        const repair = await repairDrift(applied);
        if (repair.status === 'repaired' && repair.insertedTransfers > 0) {
          receiptRecoveries += 1;
          driftEvidence = null;
          continue;
        }
        if (repair.status !== 'repaired') {
          deferDrift(applied);
          driftDeferred += 1;
          break;
        }
        const observations = observeDrift(applied);
        if (observations < 3) break;
        const confirmed = await ledger.applyNextPendingEvent({
          confirmDriftFingerprint: applied.fingerprint,
        });
        if (confirmed.status !== 'drifted') {
          const error = new Error('holder live drift confirmation did not isolate the token');
          error.code = 'holder_live_apply_contract_error';
          throw error;
        }
        driftedTokens += 1;
        driftEvidence = null;
      } else {
        const error = new Error(`unexpected holder apply status: ${applied.status}`);
        error.code = 'holder_live_apply_contract_error';
        throw error;
      }
    }
    return {
      appliedEvents, driftedTokens, applyAttempts, reachedIdle,
      driftSuspicions, receiptRecoveries, driftDeferred, holderCountUpdates,
    };
  }

  async function runOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const maxApplyEvents = boundedInteger(
      input.maxApplyEvents, 5000, 1, 50_000, 'maxApplyEvents'
    );
    const prepared = await prepareTick(rangeSize, confirmations);
    if (prepared.terminal) return prepared.terminal;
    const drained = await drainPendingEvents(maxApplyEvents);
    const holderCountPublished = await publishCountUpdates(
      publishHolderCounts, drained.holderCountUpdates
    );
    return Object.freeze({
      status: 'completed', captureStatus: prepared.captured.status,
      capturedTransfers: Number(prepared.captured.transfers) || 0,
      handoffStatus: prepared.handoffStatus,
      handoffPromotions: prepared.handoffStatus === 'shadow' ? 1 : 0,
      handoffResyncs: prepared.handoffStatus === 'resyncing' ? 1 : 0,
      appliedEvents: drained.appliedEvents, driftedTokens: drained.driftedTokens,
      applyAttempts: drained.applyAttempts, driftSuspicions: drained.driftSuspicions,
      receiptRecoveries: drained.receiptRecoveries, driftDeferred: drained.driftDeferred,
      holderCountUpdates: drained.holderCountUpdates.size, holderCountPublished,
      applyBudgetExhausted: !drained.reachedIdle && drained.applyAttempts === maxApplyEvents,
      nextBlock: prepared.captured.nextBlock, safeHead: prepared.captured.safeHead,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = { createRobinhoodHolderLiveRunner };
