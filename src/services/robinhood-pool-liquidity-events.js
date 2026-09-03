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
const SNAPSHOT_BATCH_SIZE = 50;

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

async function persistSnapshotBatch(repository, snapshots) {
  if (!snapshots.length) return { saved: 0, failed: 0 };
  try {
    return { saved: await repository.recordSnapshots(snapshots), failed: 0 };
  } catch (error) {
    // Do not turn a database outage into per-pool failures or advance the range.
    if (!isSnapshotDataError(error)) throw error;
  }
  const totals = { saved: 0, failed: 0 };
  for (const snapshot of snapshots) {
    try {
      totals.saved += Number(await repository.recordSnapshot(snapshot));
    } catch (error) {
      if (!isSnapshotDataError(error)) throw error;
      await repository.recordFailure({ ...snapshot, error });
      totals.failed += 1;
    }
  }
  return totals;
}

async function valuePool(deps, pool, anchor, checkedAt) {
  try {
    const result = await deps.reader.valuePool(pool, anchor);
    if (result.liquidityUsd == null) throw unavailableError(result);
    return { snapshot: {
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
    return { failed: 1 };
  }
}

async function valuePoolsAtBlock(deps, pools, anchorBlock, options = {}) {
  if (!pools.length) {
    return Object.freeze({ anchorBlock: String(anchorBlock), affected: 0, saved: 0, failed: 0 });
  }
  const anchor = await deps.reader.readAnchor(`0x${block(anchorBlock, 'anchorBlock').toString(16)}`);
  const checkedAt = new Date((options.now || Date.now)()).toISOString();
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 5, 20));
  const totals = { saved: 0, failed: 0 };
  for (let offset = 0; offset < pools.length; offset += SNAPSHOT_BATCH_SIZE) {
    const batch = pools.slice(offset, offset + SNAPSHOT_BATCH_SIZE);
    const reader = deps.reader.forPoolsAtAnchor
      ? await deps.reader.forPoolsAtAnchor(batch, anchor) : deps.reader;
    const outcomes = await mapConcurrent(
      batch, concurrency, (pool) => valuePool({ ...deps, reader }, pool, anchor, checkedAt)
    );
    const persisted = await persistSnapshotBatch(
      deps.repository, outcomes.filter((item) => item.snapshot).map((item) => item.snapshot)
    );
    totals.saved += persisted.saved;
    totals.failed += persisted.failed + outcomes.reduce((sum, item) => sum + (item.failed || 0), 0);
  }
  return Object.freeze({
    anchorBlock: anchor.number, affected: pools.length,
    ...totals,
  });
}

async function processLiquidityEventRange(deps, input = {}, options = {}) {
  const pools = await deps.repository.listPoolsForLiquidityEvents(input.logs || []);
  return valuePoolsAtBlock(deps, pools, block(input.toBlock, 'toBlock').toString(), options);
}

async function repairLiquiditySnapshotsAfterReorg(deps, input = {}, options = {}) {
  const rewindBlock = block(input.rewindBlock, 'rewindBlock');
  const pools = await deps.repository.invalidateSnapshotsFromBlock({
    rewindBlock: rewindBlock.toString(),
  });
  const anchorBlock = rewindBlock > 0n ? rewindBlock - 1n : 0n;
  return valuePoolsAtBlock(deps, pools, anchorBlock.toString(), options);
}

module.exports = {
  LIQUIDITY_EVENT_TOPICS,
  V3_LIQUIDITY_TOPICS,
  V4_DONATE_TOPIC,
  processLiquidityEventRange,
  repairLiquiditySnapshotsAfterReorg,
};
