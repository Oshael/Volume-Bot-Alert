const HOT_PRIORITY_CLASSES = Object.freeze(['fresh-live', 'recent-shadow', 'stale-live']);
const HOT_PRIORITY_CYCLE = Object.freeze([
  'fresh-live', 'fresh-live', 'fresh-live', 'recent-shadow', 'stale-live',
]);

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

function pendingEventFilter(excluded, preferredTokenAddress) {
  const filter = {};
  if (excluded.length) filter.excludeTokenAddresses = excluded;
  if (preferredTokenAddress && !excluded.includes(preferredTokenAddress)) {
    filter.onlyTokenAddress = preferredTokenAddress;
  }
  return filter;
}

function applyBatchMetrics(result) {
  const explicitApplied = Number(result?.appliedEvents);
  const appliedEvents = Number.isSafeInteger(explicitApplied) && explicitApplied >= 0
    ? explicitApplied : (result?.status === 'applied' ? 1 : 0);
  const explicitAttempts = Number(result?.attemptedEvents);
  const attemptedEvents = Number.isSafeInteger(explicitAttempts) && explicitAttempts >= 1
    ? explicitAttempts : 1;
  return Object.freeze({ appliedEvents, attemptedEvents });
}

function quarantineMetric(result) {
  return result?.quarantinedTokens === 1 ? 1 : 0;
}

function annotateHolderError(error, stage, tokenAddress = null) {
  if (!error || typeof error !== 'object') return error;
  error.holderStage ||= stage;
  if (tokenAddress) error.holderTokenAddress ||= tokenAddress;
  return error;
}

async function withHolderErrorContext(action, stage, tokenAddress = null) {
  try {
    return await action();
  } catch (error) {
    throw annotateHolderError(error, stage, tokenAddress);
  }
}

function isLiveLedger(value) {
  return [
    'applyNextPendingEvent', 'getHotQueueFreshness',
    'listHotPendingTokenAddresses', 'listPendingTokenAddresses',
    'promoteReadyShadowTokens', 'repairCapturedRange',
    'requeueWideShadowTail', 'rollbackAppliedTail',
    'quarantineMalformedToken',
  ].every((method) => typeof value?.[method] === 'function');
}

function createRobinhoodHolderLiveRunner(options = {}) {
  const capture = options.capture;
  const handoff = options.handoff;
  const ledger = options.ledger;
  const reader = options.reader;
  const now = options.now || Date.now;
  const measureNow = options.measureNow || Date.now;
  const driftRecheckMs = boundedInteger(
    options.driftRecheckMs, 60_000, 1000, 600_000, 'driftRecheckMs'
  );
  const receiptBlockLimit = boundedInteger(
    options.receiptBlockLimit, 250, 1, 1000, 'receiptBlockLimit'
  );
  const receiptBatchSize = boundedInteger(
    options.receiptBatchSize, 25, 1, 100, 'receiptBatchSize'
  );
  const driftEvidence = new Map();
  let hotPriorityOffset = 0;
  const publishHolderCounts = typeof options.publishHolderCounts === 'function'
    ? options.publishHolderCounts : async () => 0;
  if (!isLiveLedger(ledger)) {
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

  function measureMs() {
    const value = Number(measureNow());
    if (!Number.isFinite(value)) throw new Error('holder live measurement clock is invalid');
    return value;
  }

  function elapsedMs(startedAt) {
    return Math.max(0, Math.round(measureMs() - startedAt));
  }

  async function quarantineBalanceOverflow(error, tokenAddress) {
    if (error?.code !== 'holder_balance_overflow') throw error;
    if (error.tokenAddress && error.tokenAddress !== tokenAddress) {
      const contractError = new Error('holder overflow token differs from the selected token');
      contractError.code = 'holder_live_apply_contract_error';
      throw contractError;
    }
    const quarantined = await withHolderErrorContext(
      () => ledger.quarantineMalformedToken({
        tokenAddress, exclusionReason: 'balance_overflow_live',
      }),
      'overflow_quarantine', tokenAddress
    );
    if (quarantined.status !== 'quarantined') {
      const contractError = new Error('holder overflow quarantine did not isolate the token');
      contractError.code = 'holder_live_apply_contract_error';
      throw contractError;
    }
    return Object.freeze({
      status: 'drifted', tokenAddress: quarantined.tokenAddress,
      appliedEvents: 0, attemptedEvents: 1, quarantinedTokens: 1,
    });
  }

  async function applyWithTiming(input, timing) {
    const startedAt = measureMs();
    let result;
    try {
      result = await withHolderErrorContext(
        () => ledger.applyNextPendingEvent(input), 'apply', input?.onlyTokenAddress
      );
      return result;
    } catch (error) {
      result = await quarantineBalanceOverflow(error, input?.onlyTokenAddress);
      return result;
    } finally {
      const durationMs = elapsedMs(startedAt);
      timing.applyCalls += 1;
      timing.applyCallDurationMs += durationMs;
      timing.maxApplyCallDurationMs = Math.max(
        timing.maxApplyCallDurationMs, durationMs
      );
      if (result && result.status !== 'idle') {
        const batch = applyBatchMetrics(result);
        timing.nonIdleApplyCalls += 1;
        timing.attemptedEvents += batch.attemptedEvents;
        timing.maxAttemptedEventsPerCall = Math.max(
          timing.maxAttemptedEventsPerCall, batch.attemptedEvents
        );
      }
    }
  }

  async function listPendingTokens(input, timing) {
    const startedAt = measureMs();
    try {
      return await withHolderErrorContext(
        () => ledger.listPendingTokenAddresses(input), 'pending_selection'
      );
    } finally {
      timing.selectionCalls += 1;
      timing.selectionDurationMs += elapsedMs(startedAt);
    }
  }

  async function nextHotToken(input, timing) {
    const desiredClass = HOT_PRIORITY_CYCLE[hotPriorityOffset];
    hotPriorityOffset = (hotPriorityOffset + 1) % HOT_PRIORITY_CYCLE.length;
    const classes = [desiredClass, ...HOT_PRIORITY_CLASSES.filter(
      (priorityClass) => priorityClass !== desiredClass
    )];
    for (const priorityClass of classes) {
      const startedAt = measureMs();
      let tokens;
      try {
        tokens = await withHolderErrorContext(
          () => ledger.listHotPendingTokenAddresses({
            ...input, limit: 1, priorityClass,
          }),
          'hot_selection'
        );
      } finally {
        timing.hotSelectionCalls += 1;
        timing.hotSelectionDurationMs += elapsedMs(startedAt);
      }
      if (tokens[0]) {
        timing.hotSelectionsByClass[priorityClass] += 1;
        return { tokenAddress: tokens[0], priorityClass };
      }
    }
    return { tokenAddress: null, priorityClass: null };
  }

  async function selectPendingToken(preferred, queued, roundHasMultiple, input, timing) {
    if (preferred) return { preferred, queued, roundHasMultiple };
    const refresh = queued.length === 0;
    const candidates = refresh ? [...await listPendingTokens(input, timing)] : queued;
    if (refresh) timing.selectedTokens += candidates.length;
    return {
      preferred: candidates.shift() || null,
      queued: candidates,
      roundHasMultiple: refresh ? candidates.length > 0 : roundHasMultiple,
    };
  }

  async function publishCommittedUpdates(updates, timing, tokenAddress = null) {
    if (updates.size === 0) return 0;
    const startedAt = measureMs();
    try {
      return await withHolderErrorContext(
        () => publishCountUpdates(publishHolderCounts, updates),
        'holder_publication', tokenAddress
      );
    } finally {
      timing.publicationDurationMs += elapsedMs(startedAt);
    }
  }

  async function promoteReadyShadows(input, timing) {
    const startedAt = measureMs();
    try {
      return await withHolderErrorContext(
        () => ledger.promoteReadyShadowTokens(input),
        'shadow_promotion', input.tokenAddress
      );
    } finally {
      timing.shadowPromotionDurationMs += elapsedMs(startedAt);
    }
  }

  async function publishResult(result, updates, timing, tokenAddress = null) {
    rememberHolderCountUpdate(updates, result);
    const publication = result?.publication;
    const publications = publication
      ? new Map([[publication.tokenAddress, publication]]) : new Map();
    return publishCommittedUpdates(
      publications, timing, tokenAddress || result?.tokenAddress || null
    );
  }

  async function deliverAppliedResult(applied, updates, timing) {
    let shadowPromotions = 0;
    let holderCountPublished = await publishResult(applied, updates, timing);
    if (applied.status === 'applied' && applied.tokenDrained === true) {
      const promoted = await promoteReadyShadows({
        limit: 1, tokenAddress: applied.tokenAddress,
      }, timing);
      shadowPromotions = Number(promoted.promotedTokens) || 0;
      for (const publication of promoted.publications) {
        holderCountPublished += await publishResult(
          { publication }, updates, timing, applied.tokenAddress
        );
      }
    }
    return { holderCountPublished, shadowPromotions };
  }

  function deferDrift(suspicion) {
    driftEvidence.set(suspicion.tokenAddress, Object.freeze({
      fingerprint: null, tokenAddress: suspicion.tokenAddress, observations: 0,
      nextObservationAtMs: clockMs() + driftRecheckMs,
    }));
  }

  function observeDrift(suspicion) {
    const previous = driftEvidence.get(suspicion.tokenAddress);
    const observations = previous?.fingerprint === suspicion.fingerprint
      ? previous.observations + 1 : 1;
    driftEvidence.set(suspicion.tokenAddress, Object.freeze({
      fingerprint: suspicion.fingerprint, tokenAddress: suspicion.tokenAddress,
      observations, nextObservationAtMs: clockMs() + driftRecheckMs,
    }));
    return observations;
  }

  function deferredTokenAddresses() {
    const currentMs = clockMs();
    return [...driftEvidence.values()]
      .filter(({ nextObservationAtMs }) => nextObservationAtMs > currentMs)
      .map(({ tokenAddress }) => tokenAddress);
  }

  async function repairDrift(suspicion) {
    if (suspicion.recoveryFromBlock == null) {
      return Object.freeze({ status: 'deferred', reason: 'live_tail_baseline_unavailable' });
    }
    if (suspicion.recoverySafe !== true) {
      try {
        return await ledger.rollbackAppliedTail({
          tokenAddress: suspicion.tokenAddress,
          backfillNextBlock: suspicion.recoveryFromBlock,
          failedBlock: suspicion.failedBlock,
          failedTransactionHash: suspicion.failedTransactionHash,
          failedLogIndex: suspicion.failedLogIndex,
        });
      } catch (error) {
        if (error?.code !== 'holder_tail_rollback_unavailable') throw error;
        return Object.freeze({
          status: 'unrecoverable', reason: 'tail_applied_evidence_unavailable',
        });
      }
    }
    const blocks = BigInt(suspicion.failedBlock) - BigInt(suspicion.recoveryFromBlock) + 1n;
    if (blocks < 1n) {
      return Object.freeze({ status: 'deferred', reason: 'receipt_range_invalid' });
    }
    if (blocks > BigInt(receiptBlockLimit)) {
      return ledger.requeueWideShadowTail({
        tokenAddress: suspicion.tokenAddress,
        backfillNextBlock: suspicion.recoveryFromBlock,
        failedBlock: suspicion.failedBlock,
        failedTransactionHash: suspicion.failedTransactionHash,
        failedLogIndex: suspicion.failedLogIndex,
        receiptBlockLimit,
      });
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

  async function prepareTick(input, rangeSize, confirmations) {
    if (typeof capture?.captureOnce !== 'function') {
      throw new TypeError('holder live capture is required');
    }
    if (typeof handoff?.runOnce !== 'function') {
      throw new TypeError('holder live handoff is required');
    }
    const captureInput = { rangeSize, confirmations };
    for (const key of ['admittedAfter', 'seedLimit', 'maxInitialGapBlocks']) {
      if (input[key] != null) captureInput[key] = input[key];
    }
    const captured = await capture.captureOnce(captureInput);
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
      driftEvidence.clear();
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
    if (captured.status === 'malformed-token-quarantined') {
      return { terminal: Object.freeze({
        status: 'recovered', captureStatus: captured.status,
        quarantinedTokenAddress: captured.tokenAddress, quarantinedTokens: 1,
        deletedBalances: Number(captured.deletedBalances) || 0,
        deletedJournalEvents: Number(captured.deletedJournalEvents) || 0,
        nextBlock: captured.nextBlock, safeHead: captured.safeHead,
        handoffStatus: 'skipped', handoffPromotions: 0, handoffResyncs: 0,
        appliedEvents: 0, driftedTokens: 1, applyAttempts: 0,
        holderCountUpdates: 0, holderCountPublished: 0,
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

  async function drainPendingEvents(
    maxApplyEvents, applyBatchSize, hotApplyBatchSize, maxDurationMs
  ) {
    let appliedEvents = 0;
    let driftedTokens = 0;
    let applyAttempts = 0;
    let reachedIdle = false;
    let driftSuspicions = 0;
    let receiptRecoveries = 0;
    let driftDeferred = 0;
    let tailRollbacks = 0;
    let tailRollbackEvents = 0;
    let baselineRequeues = 0;
    let quarantinedTokens = 0;
    let shadowPromotions = 0;
    let holderCountPublished = 0;
    let preferredTokenAddress = null;
    let pendingTokenAddresses = [];
    let pendingRoundHasMultiple = false;
    const timing = {
      applyCalls: 0, nonIdleApplyCalls: 0, attemptedEvents: 0,
      applyCallDurationMs: 0, maxApplyCallDurationMs: 0,
      maxAttemptedEventsPerCall: 0, driftRepairDurationMs: 0,
      selectionCalls: 0, selectionDurationMs: 0, selectedTokens: 0,
      hotSelectionCalls: 0, hotSelectionDurationMs: 0,
      hotSelectionsByClass: {
        'fresh-live': 0, 'recent-shadow': 0, 'stale-live': 0,
      },
      shadowPromotionDurationMs: 0, publicationDurationMs: 0,
    };
    const holderCountUpdates = new Map();
    const deadlineMs = measureMs() + maxDurationMs;
    while (applyAttempts < maxApplyEvents && measureMs() < deadlineMs) {
      const excluded = deferredTokenAddresses();
      const hotSelection = await nextHotToken({ excludeTokenAddresses: excluded }, timing);
      const hotTokenAddress = hotSelection.tokenAddress;
      if (hotTokenAddress) {
        preferredTokenAddress = hotTokenAddress;
      } else {
        const selected = await selectPendingToken(
          preferredTokenAddress, pendingTokenAddresses, pendingRoundHasMultiple, {
            excludeTokenAddresses: excluded,
            limit: maxApplyEvents - applyAttempts,
          }, timing
        );
        preferredTokenAddress = selected.preferred;
        pendingTokenAddresses = selected.queued;
        pendingRoundHasMultiple = selected.roundHasMultiple;
      }
      if (!preferredTokenAddress) {
        reachedIdle = excluded.length === 0;
        driftDeferred = Math.max(driftDeferred, excluded.length);
        break;
      }
      const filter = pendingEventFilter(excluded, preferredTokenAddress);
      const requestedEvents = Math.min(
        hotTokenAddress ? hotApplyBatchSize : applyBatchSize,
        maxApplyEvents - applyAttempts
      );
      const applied = await applyWithTiming({
        ...filter, maxEvents: requestedEvents,
      }, timing);
      if (applied.status === 'idle') {
        preferredTokenAddress = null;
        continue;
      }
      const batch = applyBatchMetrics(applied);
      applyAttempts += batch.attemptedEvents;
      appliedEvents += batch.appliedEvents;
      quarantinedTokens += quarantineMetric(applied);
      const delivery = await deliverAppliedResult(applied, holderCountUpdates, timing);
      holderCountPublished += delivery.holderCountPublished;
      shadowPromotions += delivery.shadowPromotions;
      if (applied.status === 'applied') {
        driftEvidence.delete(applied.tokenAddress);
        preferredTokenAddress = !hotTokenAddress && batch.attemptedEvents >= requestedEvents
          && !pendingRoundHasMultiple
          ? applied.tokenAddress || null : null;
      } else if (applied.status === 'drifted') {
        preferredTokenAddress = null;
        driftedTokens += 1;
        driftEvidence.delete(applied.tokenAddress);
      } else if (applied.status === 'drift-suspected') {
        preferredTokenAddress = null;
        driftSuspicions += 1;
        const repairStartedAt = measureMs();
        let repair;
        try {
          repair = await withHolderErrorContext(
            () => repairDrift(applied), 'drift_repair', applied.tokenAddress
          );
        } finally {
          timing.driftRepairDurationMs += elapsedMs(repairStartedAt);
        }
        if (repair.status === 'requeued') {
          if (repair.recovery === 'wide-shadow-tail') baselineRequeues += 1;
          else tailRollbacks += 1;
          tailRollbackEvents += Number(repair.revertedEvents) || 0;
          driftEvidence.delete(applied.tokenAddress);
          holderCountPublished += await publishResult(
            repair, holderCountUpdates, timing
          );
          break;
        }
        if (repair.status === 'repaired' && repair.insertedTransfers > 0) {
          receiptRecoveries += 1;
          driftEvidence.delete(applied.tokenAddress);
          preferredTokenAddress = applied.tokenAddress;
          continue;
        }
        if (!['repaired', 'unrecoverable'].includes(repair.status)) {
          deferDrift(applied);
          driftDeferred += 1;
          continue;
        }
        const observations = observeDrift(applied);
        if (observations < 3) {
          driftDeferred += 1;
          continue;
        }
        const confirmed = await applyWithTiming({
          confirmDriftFingerprint: applied.fingerprint,
          onlyTokenAddress: applied.tokenAddress,
        }, timing);
        if (confirmed.status !== 'drifted') {
          const error = new Error('holder live drift confirmation did not isolate the token');
          error.code = 'holder_live_apply_contract_error';
          throw error;
        }
        driftedTokens += 1;
        driftEvidence.delete(applied.tokenAddress);
      } else {
        const error = new Error(`unexpected holder apply status: ${applied.status}`);
        error.code = 'holder_live_apply_contract_error';
        throw error;
      }
    }
    return {
      appliedEvents, driftedTokens, applyAttempts, reachedIdle,
      driftSuspicions, receiptRecoveries, driftDeferred, holderCountUpdates,
      tailRollbacks, tailRollbackEvents, baselineRequeues, quarantinedTokens, timing,
      shadowPromotions, holderCountPublished,
      durationBudgetExhausted: !reachedIdle && measureMs() >= deadlineMs,
    };
  }

  async function captureOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const prepared = await prepareTick(input, rangeSize, confirmations);
    if (prepared.terminal) return prepared.terminal;
    return Object.freeze({
      status: 'completed', captureStatus: prepared.captured.status,
      capturedTransfers: Number(prepared.captured.transfers) || 0,
      ...(prepared.captured.seededTokens == null ? {} : {
        seededTokens: Number(prepared.captured.seededTokens) || 0,
        bufferedSeededTokens: Number(prepared.captured.bufferedSeededTokens) || 0,
      }),
      handoffStatus: prepared.handoffStatus,
      handoffPromotions: prepared.handoffStatus === 'shadow' ? 1 : 0,
      handoffResyncs: prepared.handoffStatus === 'resyncing' ? 1 : 0,
      nextBlock: prepared.captured.nextBlock, safeHead: prepared.captured.safeHead,
    });
  }

  async function applyOnce(input = {}) {
    const maxApplyEvents = boundedInteger(
      input.maxApplyEvents, 5000, 1, 50_000, 'maxApplyEvents'
    );
    const applyBatchSize = boundedInteger(
      input.applyBatchSize, 100, 1, 1000, 'applyBatchSize'
    );
    const hotApplyBatchSize = boundedInteger(
      input.hotApplyBatchSize, 25, 1, 100, 'hotApplyBatchSize'
    );
    const maxDurationMs = boundedInteger(
      input.maxDurationMs, 2000, 250, 60_000, 'maxDurationMs'
    );
    const totalStartedAt = measureMs();
    const drainStartedAt = measureMs();
    const drained = await drainPendingEvents(
      maxApplyEvents, applyBatchSize, hotApplyBatchSize, maxDurationMs
    );
    const drainDurationMs = elapsedMs(drainStartedAt);
    const promoted = await promoteReadyShadows({ limit: maxApplyEvents }, drained.timing);
    const promotedUpdates = new Map();
    for (const publication of promoted.publications) {
      rememberHolderCountUpdate(drained.holderCountUpdates, { publication });
      promotedUpdates.set(publication.tokenAddress, publication);
    }
    const holderCountPublished = drained.holderCountPublished
      + await publishCommittedUpdates(
        promotedUpdates, drained.timing
      );
    const shadowPromotions = drained.shadowPromotions
      + (Number(promoted.promotedTokens) || 0);
    const totalDurationMs = elapsedMs(totalStartedAt);
    const applyTiming = drained.timing;
    const timing = Object.freeze({
      totalDurationMs, drainDurationMs,
      applyCallDurationMs: applyTiming.applyCallDurationMs,
      maxApplyCallDurationMs: applyTiming.maxApplyCallDurationMs,
      applyCalls: applyTiming.applyCalls,
      nonIdleApplyCalls: applyTiming.nonIdleApplyCalls,
      selectionDurationMs: applyTiming.selectionDurationMs,
      selectionCalls: applyTiming.selectionCalls,
      hotSelectionDurationMs: applyTiming.hotSelectionDurationMs,
      hotSelectionCalls: applyTiming.hotSelectionCalls,
      selectedTokens: applyTiming.selectedTokens,
      averageAttemptedEventsPerNonIdleCall: applyTiming.nonIdleApplyCalls > 0
        ? Number((applyTiming.attemptedEvents / applyTiming.nonIdleApplyCalls).toFixed(2)) : 0,
      maxAttemptedEventsPerCall: applyTiming.maxAttemptedEventsPerCall,
      driftRepairDurationMs: applyTiming.driftRepairDurationMs,
      drainOverheadDurationMs: Math.max(
        0, drainDurationMs - applyTiming.applyCallDurationMs
          - applyTiming.driftRepairDurationMs - applyTiming.selectionDurationMs
          - applyTiming.hotSelectionDurationMs - applyTiming.shadowPromotionDurationMs
          - applyTiming.publicationDurationMs
      ),
      shadowPromotionDurationMs: applyTiming.shadowPromotionDurationMs,
      publicationDurationMs: applyTiming.publicationDurationMs,
      appliedEventsPerSecond: totalDurationMs > 0
        ? Number((drained.appliedEvents * 1000 / totalDurationMs).toFixed(2)) : 0,
      configuredBatchSize: applyBatchSize, configuredHotBatchSize: hotApplyBatchSize,
      maxApplyEvents, maxDurationMs,
    });
    return Object.freeze({
      status: 'completed',
      appliedEvents: drained.appliedEvents, driftedTokens: drained.driftedTokens,
      applyAttempts: drained.applyAttempts, driftSuspicions: drained.driftSuspicions,
      receiptRecoveries: drained.receiptRecoveries, driftDeferred: drained.driftDeferred,
      tailRollbacks: drained.tailRollbacks, tailRollbackEvents: drained.tailRollbackEvents,
      baselineRequeues: drained.baselineRequeues,
      quarantinedTokens: drained.quarantinedTokens,
      shadowPromotions,
      holderCountUpdates: drained.holderCountUpdates.size, holderCountPublished,
      freshness: await ledger.getHotQueueFreshness(),
      applyBudgetExhausted: !drained.reachedIdle
        && (drained.applyAttempts === maxApplyEvents || drained.durationBudgetExhausted),
      timing,
    });
  }

  async function runOnce(input = {}) {
    const captured = await captureOnce(input);
    if (captured.status !== 'completed') return captured;
    return Object.freeze({ ...captured, ...await applyOnce(input), status: 'completed' });
  }

  return Object.freeze({ runOnce, captureOnce, applyOnce });
}

module.exports = { createRobinhoodHolderLiveRunner };
