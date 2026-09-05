const { performance } = require('node:perf_hooks');
const { POOL_LIQUIDITY_BATCH_SIZE } = require('../utils/robinhood-liquidity-limits');

const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

const V3_LIQUIDITY_TOPICS = Object.freeze({
  mint: '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  burn: '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
  collect: '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0',
  flash: '0xbdbdb71d7860376ba52b25a5028beea23581364a40522f6bcfb86bb1f2dca633',
});
const V4_DONATE_TOPIC = '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb';
const LIQUIDITY_EVENT_TOPICS = Object.freeze([
  v2.TOPICS.sync,
  V3_LIQUIDITY_TOPICS.mint,
  V3_LIQUIDITY_TOPICS.burn,
  V3_LIQUIDITY_TOPICS.collect,
  v3.TOPICS.swap,
  V3_LIQUIDITY_TOPICS.flash,
  v4.TOPICS.modifyLiquidity,
  v4.TOPICS.swap,
  V4_DONATE_TOPIC,
]);

function block(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized) && !/^0x[0-9a-f]+$/i.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(normalized);
}

function unavailableError(result) {
  const error = new Error(`liquidity unavailable: ${result?.status || 'unknown'}`);
  error.code = 'liquidity_unavailable';
  return error;
}

async function mapConcurrent(items, concurrency, operation) {
  const output = new Array(items.length);
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await operation(items[index]);
    }
  }));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return output;
}

function isSnapshotDataError(error) {
  return error?.code === 'liquidity_snapshot_invalid' || /^(22|23)[A-Z0-9]{3}$/.test(error?.code);
}

function createRangeTiming(options = {}) {
  const now = options.timingNow || (() => performance.now());
  const startedAt = now();
  const stages = {
    poolLookupMs: 0,
    anchorMs: 0,
    v4PrefetchMs: 0,
    valuationMs: 0,
    persistMs: 0,
  };
  const counts = {
    logs: 0,
    pools: 0,
    chunks: 0,
    snapshots: 0,
    failures: 0,
  };
  const ms = (value) => Math.round(Math.max(0, value) * 1000) / 1000;
  return {
    counts,
    async measure(stage, operation) {
      const started = now();
      try {
        return await operation();
      } finally {
        stages[stage] += now() - started;
      }
    },
    snapshot() {
      return Object.freeze({
        totalMs: ms(now() - startedAt),
        poolLookupMs: ms(stages.poolLookupMs),
        anchorMs: ms(stages.anchorMs),
        v4PrefetchMs: ms(stages.v4PrefetchMs),
        valuationMs: ms(stages.valuationMs),
        persistMs: ms(stages.persistMs),
        ...counts,
      });
    },
  };
}

async function persistSnapshotBatch(repository, snapshots) {
  if (!snapshots.length) return { saved: 0, failed: 0, failedPools: [] };
  try {
    return { saved: await repository.recordSnapshots(snapshots), failed: 0, failedPools: [] };
  } catch (error) {
    // Do not turn a database outage into per-pool failures or advance the range.
    if (!isSnapshotDataError(error)) throw error;
  }
  const totals = { saved: 0, failed: 0, failedPools: [] };
  for (const snapshot of snapshots) {
    try {
      totals.saved += Number(await repository.recordSnapshot(snapshot));
    } catch (error) {
      if (!isSnapshotDataError(error)) throw error;
      await repository.recordFailure({ ...snapshot, error });
      totals.failed += 1;
      totals.failedPools.push({
        protocol: snapshot.protocol, marketKey: snapshot.marketKey, error,
      });
    }
  }
  return totals;
}

async function valuePool(deps, pool, anchor, checkedAt) {
  try {
    const result = await deps.reader.valuePool(pool, anchor);
    if (result.liquidityUsd == null) throw unavailableError(result);
    return { pool, snapshot: {
      protocol: pool.protocol, marketKey: pool.marketKey,
      blockNumber: result.number, blockHash: result.hash,
      observedAt: result.observedAt, checkedAt,
      liquidityUsd: result.liquidityUsd, liquidityRaw: result.liquidityRaw,
      liquidityStatus: result.status, liquidityConfidence: result.confidence,
      liquidityWarning: result.warning,
    } };
  } catch (error) {
    await deps.repository.recordFailure({
      protocol: pool.protocol, marketKey: pool.marketKey, checkedAt, error,
    });
    return { pool, failed: 1, error };
  }
}

function poolResult(pool, status, error) {
  const result = { protocol: pool.protocol, marketKey: pool.marketKey, status };
  if (error) result.error = Object.freeze({
    code: String(error.code || 'liquidity_refresh_error'),
    message: String(error.message || error),
  });
  return Object.freeze(result);
}

function prepareBatchReader(deps, batch, anchor, timing) {
  if (!deps.reader.forPoolsAtAnchor) return Promise.resolve({ reader: deps.reader });
  return timing.measure('v4PrefetchMs', () => deps.reader.forPoolsAtAnchor(batch, anchor))
    .then((reader) => ({ reader }), (error) => ({ error }));
}

async function preparedReader(result) {
  const prepared = await result;
  if (prepared.error) throw prepared.error;
  return prepared.reader;
}

async function valuePoolsAtBlock(deps, pools, anchorBlock, options = {}) {
  const timing = options.timing || createRangeTiming(options);
  timing.counts.pools = pools.length;
  if (!pools.length) {
    const result = {
      anchorBlock: String(anchorBlock), affected: 0, saved: 0, failed: 0,
      timing: timing.snapshot(),
    };
    if (options.includePoolResults) result.poolResults = Object.freeze([]);
    return Object.freeze(result);
  }
  const anchor = await timing.measure('anchorMs', () => (
    deps.reader.readAnchor(`0x${block(anchorBlock, 'anchorBlock').toString(16)}`)
  ));
  const checkedAt = new Date((options.now || Date.now)()).toISOString();
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 5, 20));
  const totals = { saved: 0, failed: 0 };
  const poolResults = [];
  const batches = [];
  for (let offset = 0; offset < pools.length; offset += POOL_LIQUIDITY_BATCH_SIZE) {
    batches.push(pools.slice(offset, offset + POOL_LIQUIDITY_BATCH_SIZE));
  }
  let pendingReader = prepareBatchReader(deps, batches[0], anchor, timing);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    timing.counts.chunks += 1;
    const reader = await preparedReader(pendingReader);
    pendingReader = index + 1 < batches.length
      ? prepareBatchReader(deps, batches[index + 1], anchor, timing)
      : null;
    const outcomes = await timing.measure(
      'valuationMs',
      () => mapConcurrent(
        batch, concurrency, (pool) => valuePool({ ...deps, reader }, pool, anchor, checkedAt)
      )
    );
    const snapshots = outcomes.filter((item) => item.snapshot).map((item) => item.snapshot);
    timing.counts.snapshots += snapshots.length;
    const persisted = await timing.measure(
      'persistMs',
      () => persistSnapshotBatch(deps.repository, snapshots)
    );
    const persistFailures = new Map(persisted.failedPools.map((item) => [
      `${item.protocol}:${item.marketKey}`, item.error,
    ]));
    for (const outcome of outcomes) {
      if (outcome.failed) {
        poolResults.push(poolResult(outcome.pool, 'failed', outcome.error));
        continue;
      }
      const error = persistFailures.get(`${outcome.pool.protocol}:${outcome.pool.marketKey}`);
      poolResults.push(poolResult(outcome.pool, error ? 'failed' : 'completed', error));
    }
    totals.saved += persisted.saved;
    totals.failed += persisted.failed + outcomes.reduce((sum, item) => sum + (item.failed || 0), 0);
  }
  timing.counts.failures = totals.failed;
  const result = {
    anchorBlock: anchor.number, affected: pools.length,
    ...totals,
    timing: timing.snapshot(),
  };
  if (options.includePoolResults) result.poolResults = Object.freeze(poolResults);
  return Object.freeze(result);
}

async function processLiquidityEventRange(deps, input = {}, options = {}) {
  const timing = createRangeTiming(options);
  const logs = input.logs || [];
  timing.counts.logs = logs.length;
  const pools = await timing.measure(
    'poolLookupMs',
    () => deps.repository.listPoolsForLiquidityEvents(logs)
  );
  return valuePoolsAtBlock(deps, pools, block(input.toBlock, 'toBlock').toString(), {
    ...options,
    timing,
  });
}

async function repairLiquiditySnapshotsAfterReorg(deps, input = {}, options = {}) {
  const rewindBlock = block(input.rewindBlock, 'rewindBlock');
  const timing = createRangeTiming(options);
  const pools = await timing.measure(
    'poolLookupMs',
    () => deps.repository.invalidateSnapshotsFromBlock({ rewindBlock: rewindBlock.toString() })
  );
  const anchorBlock = rewindBlock > 0n ? rewindBlock - 1n : 0n;
  return valuePoolsAtBlock(deps, pools, anchorBlock.toString(), { ...options, timing });
}

module.exports = {
  LIQUIDITY_EVENT_TOPICS,
  V3_LIQUIDITY_TOPICS,
  V4_DONATE_TOPIC,
  processLiquidityEventRange,
  repairLiquiditySnapshotsAfterReorg,
  valuePoolsAtBlock,
};
