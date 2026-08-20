const DEFAULT_RANGE_SIZE = 250;
const DEFAULT_PREFETCH = 4;
const DEFAULT_FINALITY_BLOCKS = 2000;
const LIVE_LAG_GROWTH_TOLERANCE_BLOCKS = 25n;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    rangeSize: boundedInteger(input.rangeSize, DEFAULT_RANGE_SIZE, 1, 5000, 'rangeSize'),
    prefetch: boundedInteger(input.prefetch, DEFAULT_PREFETCH, 1, 8, 'prefetch'),
    finalityBlocks: boundedInteger(
      input.finalityBlocks, DEFAULT_FINALITY_BLOCKS, 2000, 100_000, 'finalityBlocks'
    ),
    maxCommitMs: boundedInteger(input.maxCommitMs, 2000, 1, 300_000, 'maxCommitMs'),
    maxLiveLagBlocks: boundedInteger(
      input.maxLiveLagBlocks, 100, 0, 1_000_000, 'maxLiveLagBlocks'
    ),
  });
}

function planRanges(fromBlock, throughBlock, rangeSize, limit) {
  const ranges = [];
  let cursor = fromBlock;
  while (cursor <= throughBlock && ranges.length < limit) {
    const candidate = cursor + BigInt(rangeSize) - 1n;
    const toBlock = candidate < throughBlock ? candidate : throughBlock;
    ranges.push(Object.freeze({ fromBlock: cursor.toString(), toBlock: toBlock.toString() }));
    cursor = toBlock + 1n;
  }
  return Object.freeze(ranges);
}

function mergeFetchedRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error('global holder fetched range batch is empty');
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (BigInt(ranges[index - 1].toBlock) + 1n !== BigInt(ranges[index].fromBlock)) {
      throw new Error('global holder fetched range batch is not contiguous');
    }
  }
  const first = ranges[0];
  const last = ranges.at(-1);
  return Object.freeze({
    fromBlock: first.fromBlock, toBlock: last.toBlock, nextBlock: last.nextBlock,
    checkpoint: last.checkpoint,
    transfers: Object.freeze(ranges.flatMap((range) => range.transfers)),
  });
}

function mergeReceiptRepair(range, deficit, receiptRange) {
  const failedBlock = BigInt(deficit.failedBlock);
  const expectedHash = String(deficit.fingerprint || '').split(':')[0];
  if (receiptRange.checkpoint?.hash !== expectedHash) {
    const error = new Error('receipt repair checkpoint changed');
    error.code = 'holder_global_backfill_receipt_checkpoint_changed';
    throw error;
  }
  const retained = range.transfers.filter((transfer) => (
    transfer.tokenAddress !== deficit.tokenAddress || BigInt(transfer.blockNumber) > failedBlock
  ));
  return [...retained, ...receiptRange.transfers];
}

function batchTelemetry(timing, planned, committed, completedAt) {
  const durationMs = Math.max(0, completedAt - timing.startedAt);
  const committedBlocks = committed.reduce((total, range) => (
    total + Number(BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n)
  ), 0);
  return Object.freeze({
    durationMs, rpcWaitMs: timing.rpcWaitMs,
    rpcRangeDurationMs: timing.rpcRangeDurationMs,
    maxRpcRangeDurationMs: timing.maxRpcRangeDurationMs,
    commitDurationMs: timing.commitDurationMs,
    overheadMs: Math.max(0, durationMs - timing.rpcWaitMs - timing.commitDurationMs),
    rangesPlanned: planned.length, rangesCommitted: committed.length,
    committedBlocks,
    blocksPerSecond: durationMs > 0
      ? Number((committedBlocks * 1000 / durationMs).toFixed(3)) : null,
    rpcRequests: timing.rpcRequests, observedLogs: timing.observedLogs,
    acceptedTransfers: timing.acceptedTransfers,
  });
}

function observeBatchFetch(timing, fetched) {
  timing.rpcRangeDurationMs += fetched.durationMs;
  timing.maxRpcRangeDurationMs = Math.max(
    timing.maxRpcRangeDurationMs, fetched.durationMs
  );
  timing.rpcRequests += Number(fetched.value.telemetry?.requests || 0);
  timing.observedLogs += Number(fetched.value.telemetry?.observedLogs || 0);
  timing.acceptedTransfers += fetched.value.transfers.length;
}

function createRobinhoodHolderGlobalBackfillScanner(deps = {}) {
  const lifecycle = deps.lifecycleRepository;
  const committer = deps.commitRepository;
  const reader = deps.reader;
  if (typeof lifecycle?.getActiveRun !== 'function'
      || typeof lifecycle?.loadCohort !== 'function') {
    throw new TypeError('global holder lifecycle repository is required');
  }
  if (typeof committer?.commitRange !== 'function'
      || typeof committer?.excludeToken !== 'function') {
    throw new TypeError('global holder commit repository is required');
  }
  if (typeof reader?.readGlobalRange !== 'function'
      || typeof reader?.readReceiptRange !== 'function'
      || typeof reader?.getSafeHead !== 'function') {
    throw new TypeError('global holder transfer reader is required');
  }
  const options = normalizeOptions(deps.options);
  const now = deps.now || Date.now;
  let activeRun = null;
  let cachedRunId = null;
  let cohortSchedule = Object.freeze([]);
  let effectivePrefetch = options.prefetch;
  let stableBatches = 0;
  let lastLiveLag = null;
  let liveLagDelta = null;
  let liveLagTrend = 'unknown';
  let lastBatch = null;
  const totals = {
    fetchedRanges: 0, committedRanges: 0, discardedPrefetch: 0,
    rpcRequests: 0, observedLogs: 0, acceptedTransfers: 0, ignoredLogs: 0,
    touchedTokens: 0, touchedWallets: 0, splits: 0, addressSplits: 0,
    receiptRecoveries: 0, exclusions: 0,
  };

  function reducePrefetch() {
    effectivePrefetch = Math.max(1, Math.ceil(effectivePrefetch / 2));
    stableBatches = 0;
  }

  function observeHealthyBatch(pressured, allowGrowth = true) {
    if (pressured) {
      reducePrefetch();
      return;
    }
    if (!allowGrowth) {
      stableBatches = 0;
      return;
    }
    stableBatches += 1;
    if (stableBatches >= 3 && effectivePrefetch < options.prefetch) {
      effectivePrefetch += 1;
      stableBatches = 0;
    }
  }

  function observeLiveLag(value) {
    const current = quantity(value, 'liveLagBlocks');
    liveLagDelta = lastLiveLag == null ? null : current - lastLiveLag;
    lastLiveLag = current;
    if (current <= BigInt(options.maxLiveLagBlocks)) {
      liveLagTrend = 'healthy';
      return true;
    }
    if (liveLagDelta == null) {
      effectivePrefetch = 1;
      stableBatches = 0;
      liveLagTrend = 'observing';
      return false;
    }
    if (liveLagDelta < 0n) {
      liveLagTrend = 'improving';
      return true;
    }
    if (liveLagDelta > LIVE_LAG_GROWTH_TOLERANCE_BLOCKS) {
      liveLagTrend = 'worsening';
      reducePrefetch();
      return false;
    }
    liveLagTrend = 'steady';
    stableBatches = 0;
    return false;
  }

  async function loadCohort(runId) {
    if (cachedRunId !== runId) {
      if (typeof lifecycle.loadCohortSchedule === 'function') {
        cohortSchedule = await lifecycle.loadCohortSchedule({ runId });
      } else {
        cohortSchedule = (await lifecycle.loadCohort({ runId })).map((tokenAddress) => ({
          tokenAddress, deploymentBlock: '0',
        }));
      }
      cachedRunId = runId;
    }
    return cohortSchedule;
  }

  function rangeScope(schedule, toBlock) {
    const through = BigInt(toBlock);
    return schedule
      .filter((token) => BigInt(token.deploymentBlock) <= through)
      .map((token) => token.tokenAddress);
  }

  async function excludeCohortToken(runId, tokenAddress, reason) {
    const excluded = await committer.excludeToken({
      runId, tokenAddress, reason,
    });
    cohortSchedule = Object.freeze(cohortSchedule.filter(
      (token) => token.tokenAddress !== tokenAddress
    ));
    totals.exclusions += 1;
    return Object.freeze({ ...excluded, reason });
  }

  function excludeMalformed(runId, error) {
    return excludeCohortToken(
      runId, error.tokenAddress, 'malformed_transfer_log'
    );
  }

  async function throughBlock(input, run) {
    let through;
    if (input.throughBlock != null) {
      through = quantity(input.throughBlock, 'throughBlock');
    } else {
      through = quantity(
        (await reader.getSafeHead(options.finalityBlocks)).safeHead, 'safeHead'
      );
    }
    if (run.barrierBlock != null) {
      const barrierThrough = BigInt(run.barrierBlock) - 1n;
      if (barrierThrough < through) through = barrierThrough;
    }
    return through;
  }

  async function verifyDeficit(runId, range, deficit) {
    let receipts;
    try {
      receipts = await reader.readReceiptRange({
        tokenAddress: deficit.tokenAddress,
        fromBlock: range.fromBlock,
        toBlock: deficit.failedBlock,
      });
      const repairedTransfers = mergeReceiptRepair(range, deficit, receipts);
      const committed = await committer.commitRange({
        ...range, runId, transfers: repairedTransfers,
      });
      totals.receiptRecoveries += 1;
      return Object.freeze({ ...committed, recoverySource: 'receipts' });
    } catch (error) {
      if (error.code === 'holder_transfer_invalid_log' && error.tokenAddress) {
        return excludeMalformed(runId, error);
      }
      if (error.code !== 'holder_negative_balance') {
        return Object.freeze({
          status: 'deficit-unverified', tokenAddress: deficit.tokenAddress,
          failedBlock: deficit.failedBlock,
          reason: String(error.code || error.message || error).slice(0, 160),
        });
      }
      return excludeCohortToken(
        runId, deficit.tokenAddress, 'receipt_replay_still_negative'
      );
    }
  }

  async function commitFetched(runId, range) {
    const startedAt = now();
    try {
      const committed = await committer.commitRange({ ...range, runId });
      return { committed, durationMs: Math.max(0, now() - startedAt) };
    } catch (error) {
      if (error.code !== 'holder_negative_balance') throw error;
      const committed = await verifyDeficit(runId, range, error);
      return { committed, durationMs: Math.max(0, now() - startedAt) };
    }
  }

  async function commitFetchedBatch(runId, ranges) {
    const merged = mergeFetchedRanges(ranges);
    if (BigInt(merged.toBlock) - BigInt(merged.fromBlock) + 1n > 5000n) return null;
    const startedAt = now();
    try {
      const committed = await committer.commitRange({ ...merged, runId });
      return Object.freeze({ committed, durationMs: Math.max(0, now() - startedAt) });
    } catch (error) {
      if (error.code === 'holder_negative_balance') return null;
      throw error;
    }
  }

  async function commitFetchedIndividually(runId, ranges) {
    const committed = [];
    let durationMs = 0;
    for (const range of ranges) {
      const outcome = await commitFetched(runId, range);
      durationMs += outcome.durationMs;
      if (outcome.committed.status !== 'committed') {
        return Object.freeze({ committed, durationMs, terminal: outcome.committed });
      }
      committed.push(outcome.committed);
    }
    return Object.freeze({ committed, durationMs, terminal: null });
  }

  async function commitFetchedSet(runId, ranges) {
    const batched = ranges.length > 1 ? await commitFetchedBatch(runId, ranges) : null;
    if (batched) return Object.freeze({
      committed: ranges, durationMs: batched.durationMs, terminal: null,
      touchedTokens: Number(batched.committed.touchedTokens || 0),
      touchedWallets: Number(batched.committed.touchedWallets || 0),
    });
    const individual = await commitFetchedIndividually(runId, ranges);
    return Object.freeze({
      ...individual,
      touchedTokens: individual.committed.reduce(
        (total, range) => total + Number(range.touchedTokens || 0), 0
      ),
      touchedWallets: individual.committed.reduce(
        (total, range) => total + Number(range.touchedWallets || 0), 0
      ),
    });
  }

  async function handleFetchError(error, context) {
    if (['timeout', 'rate_limited', 'log_range_error'].includes(error.code)) reducePrefetch();
    totals.discardedPrefetch += context.pending.length - context.index - 1;
    if (error.code === 'holder_transfer_invalid_log' && error.tokenAddress) {
      const excluded = await excludeMalformed(context.runId, error);
      await Promise.all(context.pending);
      return Object.freeze({
        ...excluded, runId: context.runId,
        committedRanges: context.committedRanges, prefetch: effectivePrefetch,
      });
    }
    await Promise.all(context.pending);
    throw error;
  }

  function observeFetched(value, durationMs) {
    totals.fetchedRanges += 1;
    totals.rpcRequests += Number(value.telemetry?.requests || 0);
    totals.observedLogs += Number(value.telemetry?.observedLogs || 0);
    totals.ignoredLogs += Number(value.telemetry?.ignoredLogs || 0);
    totals.splits += Number(value.telemetry?.splits || 0);
    totals.addressSplits += Number(value.telemetry?.addressSplits || 0);
    return { value, durationMs };
  }

  async function scanOnce(input = {}) {
    const run = await lifecycle.getActiveRun();
    if (!run) return Object.freeze({ status: 'idle', reason: 'no_active_run' });
    if (!['scanning', 'attached'].includes(run.status)) {
      return Object.freeze({ status: 'idle', reason: `run_${run.status}`, runId: run.id });
    }
    const allowPrefetchGrowth = observeLiveLag(input.liveLagBlocks ?? 0);
    const target = await throughBlock(input, run);
    const nextBlock = BigInt(run.nextBlock);
    if (nextBlock > target) {
      return Object.freeze({
        status: 'caught-up', runId: run.id, nextBlock: run.nextBlock,
        throughBlock: target.toString(), prefetch: effectivePrefetch,
      });
    }
    const schedule = await loadCohort(run.id);
    const planned = planRanges(nextBlock, target, options.rangeSize, effectivePrefetch);
    const timing = {
      startedAt: now(), rpcWaitMs: 0, rpcRangeDurationMs: 0,
      maxRpcRangeDurationMs: 0, commitDurationMs: 0,
      rpcRequests: 0, observedLogs: 0, acceptedTransfers: 0,
    };
    const pending = planned.map((range) => {
      const startedAt = now();
      return reader.readGlobalRange({ tokenAddresses: rangeScope(schedule, range.toBlock), ...range })
        .then((value) => observeFetched(value, Math.max(0, now() - startedAt)),
          (error) => ({ error }));
    });
    let committed = [];
    const fetchedRanges = [];
    let pressured = false;
    for (let index = 0; index < pending.length; index += 1) {
      const waitStartedAt = now();
      const fetched = await pending[index];
      timing.rpcWaitMs += Math.max(0, now() - waitStartedAt);
      if (fetched.error) {
        const prefix = await commitFetchedIndividually(run.id, fetchedRanges);
        timing.commitDurationMs += prefix.durationMs;
        committed = prefix.committed;
        if (prefix.terminal) {
          totals.committedRanges += committed.length;
          totals.acceptedTransfers += fetchedRanges.slice(0, committed.length).reduce(
            (total, range) => total + range.transfers.length, 0
          );
          totals.touchedTokens += committed.reduce(
            (total, range) => total + Number(range.touchedTokens || 0), 0
          );
          totals.touchedWallets += committed.reduce(
            (total, range) => total + Number(range.touchedWallets || 0), 0
          );
          totals.discardedPrefetch += pending.length - committed.length - 1;
          await Promise.all(pending);
          observeHealthyBatch(true, allowPrefetchGrowth);
          return Object.freeze({
            ...prefix.terminal, runId: run.id, committedRanges: committed.length,
            prefetch: effectivePrefetch,
          });
        }
        totals.committedRanges += committed.length;
        totals.acceptedTransfers += fetchedRanges.reduce(
          (total, range) => total + range.transfers.length, 0
        );
        totals.touchedTokens += committed.reduce(
          (total, range) => total + Number(range.touchedTokens || 0), 0
        );
        totals.touchedWallets += committed.reduce(
          (total, range) => total + Number(range.touchedWallets || 0), 0
        );
        return handleFetchError(fetched.error, {
          runId: run.id, pending, index, committedRanges: committed.length,
        });
      }
      observeBatchFetch(timing, fetched);
      pressured ||= Number(fetched.value.telemetry?.splits || 0) > 0;
      fetchedRanges.push(fetched.value);
    }
    const committedSet = await commitFetchedSet(run.id, fetchedRanges);
    timing.commitDurationMs += committedSet.durationMs;
    pressured ||= committedSet.durationMs > options.maxCommitMs;
    committed = committedSet.committed;
    if (committedSet.terminal) {
      totals.discardedPrefetch += fetchedRanges.length - committed.length - 1;
      observeHealthyBatch(true, allowPrefetchGrowth);
      return Object.freeze({
        ...committedSet.terminal, runId: run.id, committedRanges: committed.length,
        prefetch: effectivePrefetch,
      });
    }
    totals.committedRanges += committed.length;
    totals.touchedTokens += committedSet.touchedTokens;
    totals.touchedWallets += committedSet.touchedWallets;
    totals.acceptedTransfers += fetchedRanges.reduce(
      (total, range) => total + range.transfers.length, 0
    );
    lastBatch = batchTelemetry(timing, planned, committed, now());
    observeHealthyBatch(pressured, allowPrefetchGrowth);
    return Object.freeze({
      status: 'committed', runId: run.id, ranges: committed.length,
      fromBlock: committed[0].fromBlock, toBlock: committed.at(-1).toBlock,
      nextBlock: committed.at(-1).nextBlock, prefetch: effectivePrefetch,
    });
  }

  function runOnce(input = {}) {
    if (activeRun) return activeRun;
    activeRun = scanOnce(input).finally(() => { activeRun = null; });
    return activeRun;
  }

  return Object.freeze({
    runOnce,
    getStatus: () => Object.freeze({
      prefetch: effectivePrefetch, stableBatches, active: activeRun !== null,
      liveLagBlocks: lastLiveLag?.toString() ?? null,
      liveLagDeltaBlocks: liveLagDelta?.toString() ?? null, liveLagTrend,
      lastBatch,
      totals: Object.freeze({ ...totals }),
    }),
  });
}

module.exports = {
  createRobinhoodHolderGlobalBackfillScanner,
  __private: {
    batchTelemetry, mergeFetchedRanges, mergeReceiptRepair, normalizeOptions, planRanges,
  },
};
