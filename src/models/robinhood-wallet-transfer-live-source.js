const db = require('./db');

const CHAIN = 'robinhood';
const MAX_IDENTITIES = 10_000;

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a timestamp`);
  return date.toISOString();
}

function blockNumber(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function optionalBlockNumber(value) {
  return value == null ? null : String(value);
}

function projectionVersion(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('projectionVersion is invalid');
  }
  return normalized;
}

function identityList(values, label, bytes) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be a list`);
  if (values.length > MAX_IDENTITIES) throw new RangeError(`${label} exceeds ${MAX_IDENTITIES}`);
  return [...new Set(values.map((value) => fixedHex(value, label, bytes)))];
}

function sourceFrontier(row) {
  if (!row) return Object.freeze({ ready: false, reason: 'swap_live_missing' });
  const base = {
    originBlock: optionalBlockNumber(row.origin_block),
    nextBlock: row.next_block == null ? null : String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash || null,
    checkpointTimestamp: row.checkpoint_timestamp
      ? new Date(row.checkpoint_timestamp).toISOString() : null,
    lifecycleState: row.lifecycle_state || null, version: Number(row.version),
  };
  if (base.lifecycleState !== 'running') {
    return Object.freeze({ ready: false, reason: 'swap_live_not_running', ...base });
  }
  if (base.nextBlock === null || BigInt(base.nextBlock) === 0n || base.safeHead === null) {
    return Object.freeze({ ready: false, reason: 'swap_live_frontier_invalid', ...base });
  }
  const completeThroughBlock = (BigInt(base.nextBlock) - 1n).toString();
  if (BigInt(completeThroughBlock) > BigInt(base.safeHead)) {
    return Object.freeze({
      ready: false, reason: 'swap_live_frontier_unproven', completeThroughBlock, ...base,
    });
  }
  const checkpointValid = base.checkpointBlock !== null && base.checkpointHash !== null
    && base.checkpointTimestamp !== null
    && /^0x[0-9a-f]{64}$/.test(base.checkpointHash)
    && BigInt(base.checkpointBlock) <= BigInt(completeThroughBlock);
  if (!checkpointValid) {
    return Object.freeze({
      ready: false, reason: 'swap_live_checkpoint_invalid', completeThroughBlock, ...base,
    });
  }
  return Object.freeze({ ready: true, reason: null, completeThroughBlock, ...base });
}

function invalidBackfillFrontier(reason, seed = null, live = null) {
  return Object.freeze({
    ready: false, reason, historicalFromBlock: null, historicalThroughBlock: null,
    completeThroughBlock: null, seed, live,
  });
}

function seedFrontier(row) {
  if (!row) return Object.freeze({ ready: false, reason: 'swap_seed_missing' });
  const base = {
    originBlock: row.origin_block == null ? null : String(row.origin_block),
    nextBlock: row.next_block == null ? null : String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    lifecycleState: row.lifecycle_state || null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    version: Number(row.version),
  };
  if (base.lifecycleState !== 'complete') {
    return Object.freeze({ ready: false, reason: 'swap_seed_not_complete', ...base });
  }
  const terminal = base.nextBlock !== null && base.safeHead !== null
    && BigInt(base.nextBlock) > BigInt(base.safeHead) && base.completedAt !== null;
  if (!terminal) {
    return Object.freeze({ ready: false, reason: 'swap_seed_terminal_invalid', ...base });
  }
  if (base.originBlock === null) {
    return Object.freeze({ ready: false, reason: 'swap_seed_origin_missing', ...base });
  }
  if (BigInt(base.originBlock) > BigInt(base.safeHead)) {
    return Object.freeze({ ready: false, reason: 'swap_seed_origin_invalid', ...base });
  }
  return Object.freeze({ ready: true, reason: null, ...base });
}

function backfillFrontier(rows = []) {
  const byStream = Object.fromEntries(rows.map((row) => [row.stream, row]));
  const seed = seedFrontier(byStream.seed || null);
  const live = sourceFrontier(byStream.live || null);
  if (!seed.ready) return invalidBackfillFrontier(seed.reason, seed, live);
  if (!live.ready) return invalidBackfillFrontier(live.reason, seed, live);
  if (live.originBlock === null) {
    return invalidBackfillFrontier('swap_live_origin_missing', seed, live);
  }
  if (BigInt(live.originBlock) !== BigInt(seed.safeHead) + 1n) {
    return invalidBackfillFrontier('swap_live_origin_discontinuous', seed, live);
  }
  return Object.freeze({
    ready: true, reason: null, historicalFromBlock: seed.originBlock,
    historicalThroughBlock: seed.safeHead,
    completeThroughBlock: live.completeThroughBlock, seed, live,
  });
}

function transferCursor(row) {
  return row ? Object.freeze({
    stream: row.stream,
    originBlock: optionalBlockNumber(row.origin_block),
    nextBlock: optionalBlockNumber(row.next_block),
    safeHead: optionalBlockNumber(row.safe_head),
    lifecycleState: row.lifecycle_state || null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    version: Number(row.version),
  }) : null;
}

function invalidTransferBackfillPlan(reason, swap, seed, live) {
  return Object.freeze({
    ready: false, reason, status: 'blocked', fromBlock: null, throughBlock: null,
    nextBlock: null, remainingBlocks: null, swap, seed, live,
  });
}

function liveCursorReason(live) {
  if (!live) return 'transfer_live_missing';
  if (live.lifecycleState !== 'running') return 'transfer_live_not_running';
  if (live.originBlock === null) return 'transfer_live_origin_missing';
  if (live.nextBlock === null || BigInt(live.originBlock) > BigInt(live.nextBlock)) {
    return 'transfer_live_frontier_invalid';
  }
  return null;
}

function seedCursorReason(seed, fromBlock, throughBlock) {
  if (seed.originBlock === null) return 'transfer_seed_origin_missing';
  if (seed.originBlock !== fromBlock) return 'transfer_seed_origin_conflict';
  if (seed.safeHead !== throughBlock) return 'transfer_seed_target_conflict';
  if (seed.nextBlock === null || BigInt(seed.nextBlock) < BigInt(fromBlock)
      || BigInt(seed.nextBlock) > BigInt(throughBlock) + 1n) {
    return 'transfer_seed_frontier_invalid';
  }
  if (seed.lifecycleState === 'complete') {
    return BigInt(seed.nextBlock) === BigInt(throughBlock) + 1n && seed.completedAt !== null
      ? null : 'transfer_seed_terminal_invalid';
  }
  return ['pending', 'running'].includes(seed.lifecycleState)
    && BigInt(seed.nextBlock) <= BigInt(throughBlock)
    ? null : `transfer_seed_${seed.lifecycleState || 'state'}_invalid`;
}

function transferBackfillBoundaries(swap, live) {
  const fromBlock = swap.historicalFromBlock;
  if (BigInt(live.originBlock) < BigInt(fromBlock)) {
    return { reason: 'transfer_live_origin_before_swap_coverage' };
  }
  if (live.originBlock === fromBlock) return { fromBlock, throughBlock: null };
  const throughBlock = (BigInt(live.originBlock) - 1n).toString();
  return BigInt(throughBlock) > BigInt(swap.completeThroughBlock)
    ? { reason: 'transfer_seed_target_beyond_swap_coverage' }
    : { fromBlock, throughBlock };
}

function remainingBlockCount(status, nextBlock, throughBlock) {
  if (status === 'complete') return '0';
  return (BigInt(throughBlock) - BigInt(nextBlock) + 1n).toString();
}

function transferBackfillPlan(swap, rows = []) {
  const cursors = Object.fromEntries(rows.map((row) => [row.stream, transferCursor(row)]));
  const seed = cursors.seed || null;
  const live = cursors.live || null;
  if (!swap?.ready) {
    return invalidTransferBackfillPlan(swap?.reason || 'swap_backfill_unavailable', swap, seed, live);
  }
  const liveReason = liveCursorReason(live);
  if (liveReason) return invalidTransferBackfillPlan(liveReason, swap, seed, live);
  const boundaries = transferBackfillBoundaries(swap, live);
  if (boundaries.reason) {
    return invalidTransferBackfillPlan(boundaries.reason, swap, seed, live);
  }
  const { fromBlock, throughBlock } = boundaries;
  if (throughBlock === null) {
    if (seed) return invalidTransferBackfillPlan('transfer_seed_unexpected', swap, seed, live);
    return Object.freeze({
      ready: true, reason: null, status: 'complete', fromBlock,
      throughBlock: null, nextBlock: fromBlock, remainingBlocks: '0', swap, seed, live,
    });
  }
  if (seed) {
    const seedReason = seedCursorReason(seed, fromBlock, throughBlock);
    if (seedReason) return invalidTransferBackfillPlan(seedReason, swap, seed, live);
  }
  const nextBlock = seed?.nextBlock || fromBlock;
  const status = seed?.lifecycleState || 'uninitialized';
  return Object.freeze({
    ready: true, reason: null, status, fromBlock, throughBlock, nextBlock,
    remainingBlocks: remainingBlockCount(status, nextBlock, throughBlock),
    swap, seed, live,
  });
}

function normalizeSwap(row) {
  return Object.freeze({
    transactionHash: row.transaction_hash,
    actionIndex: String(row.action_index),
    tokenAddress: row.token_address,
    walletAddress: row.wallet_address,
    recipientAddress: row.recipient_address || null,
    routerAddress: row.router_address || null,
    tokenAmountRaw: String(row.token_amount_raw),
    side: row.side,
  });
}

function createRobinhoodWalletTransferLiveSourceRepository(options = {}) {
  const database = options.database || db;

  async function loadSwapFrontier() {
    const result = await database.query(
      `SELECT next_block, safe_head, checkpoint_block, checkpoint_hash,
              checkpoint_timestamp, lifecycle_state, version
       FROM robinhood_wallet_swap_cursors WHERE chain = $1 AND stream = 'live'`,
      [CHAIN]
    );
    return sourceFrontier(result.rows[0]);
  }

  async function loadBackfillFrontier() {
    const result = await database.query(
      `SELECT * FROM robinhood_wallet_swap_cursors
       WHERE chain = $1 AND stream IN ('seed', 'live')`,
      [CHAIN]
    );
    return backfillFrontier(result.rows);
  }

  async function loadBackfillPlan(versionInput) {
    const version = projectionVersion(versionInput);
    const [swap, cursors] = await Promise.all([
      loadBackfillFrontier(),
      database.query(
        `SELECT stream, origin_block, next_block, safe_head, lifecycle_state,
                completed_at, version
           FROM robinhood_wallet_transfer_cursors
          WHERE chain = $1 AND projection_version = $2 AND stream IN ('seed', 'live')`,
        [CHAIN, version]
      ),
    ]);
    return Object.freeze({ projectionVersion: version, ...transferBackfillPlan(swap, cursors.rows) });
  }

  async function listTrackedTokenAddresses() {
    const result = await database.query(
      `SELECT token_address FROM robinhood_holder_token_states
       WHERE chain = $1 AND ledger_status IN ('backfilling', 'shadow', 'live')
       UNION
       SELECT token.token_address FROM robinhood_holder_global_backfill_tokens token
       INNER JOIN robinhood_holder_global_backfill_runs run
         ON run.id = token.run_id AND run.chain = token.chain
       WHERE token.chain = $1 AND token.status = 'active'
         AND run.barrier_block IS NOT NULL AND run.status <> 'completed'
       ORDER BY token_address`,
      [CHAIN]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
  }

  async function readRangeContext(input, frontier) {
    const fromBlock = blockNumber(input.fromBlock, 'fromBlock');
    const toBlock = blockNumber(input.toBlock, 'toBlock');
    if (BigInt(fromBlock) > BigInt(toBlock)) throw new Error('classification block range is inverted');
    if (!frontier.ready) {
      return Object.freeze({
        ready: false, reason: frontier.reason,
        completeThroughBlock: frontier.completeThroughBlock || null,
      });
    }
    if (frontier.historicalFromBlock != null
        && BigInt(fromBlock) < BigInt(frontier.historicalFromBlock)) {
      return Object.freeze({
        ready: false, reason: 'swap_coverage_before_seed',
        historicalFromBlock: frontier.historicalFromBlock,
        completeThroughBlock: frontier.completeThroughBlock,
      });
    }
    if (BigInt(toBlock) > BigInt(frontier.completeThroughBlock)) {
      return Object.freeze({
        ready: false, reason: 'swap_coverage_incomplete',
        completeThroughBlock: frontier.completeThroughBlock,
      });
    }
    const transactionHashes = identityList(input.transactionHashes || [], 'transactionHashes', 32);
    const endpointAddresses = identityList(input.endpointAddresses || [], 'endpointAddresses', 20);
    const fromTime = timestamp(input.fromTime, 'fromTime');
    const toTime = timestamp(input.toTime, 'toTime');
    if (fromTime > toTime) throw new Error('classification time range is inverted');
    const swapPromise = transactionHashes.length === 0 ? { rows: [] } : database.query(
      `SELECT transaction_hash, action_index, token_address, wallet_address,
              recipient_address, router_address, token_amount_raw, side
       FROM robinhood_wallet_swaps
       WHERE chain = $1 AND block_time >= $2::timestamptz AND block_time <= $3::timestamptz
         AND block_number >= $4::bigint AND block_number <= $5::bigint
         AND transaction_hash = ANY($6::varchar[])
       ORDER BY block_number, action_index, transaction_hash`,
      [CHAIN, fromTime, toTime, fromBlock, toBlock, transactionHashes]
    );
    const poolPromise = endpointAddresses.length === 0 ? { rows: [] } : database.query(
      `SELECT protocol, pool_address, origin_address FROM robinhood_pool_registry
       WHERE chain = $1 AND active = true
         AND (pool_address = ANY($2::varchar[])
           OR (protocol = 'uniswap-v4' AND origin_address = ANY($2::varchar[])))`,
      [CHAIN, endpointAddresses]
    );
    const [swapResult, poolResult] = await Promise.all([swapPromise, poolPromise]);
    const swaps = swapResult.rows.map(normalizeSwap);
    const poolAddresses = new Set();
    for (const row of poolResult.rows) {
      if (row.pool_address) poolAddresses.add(row.pool_address);
      if (row.protocol === 'uniswap-v4' && row.origin_address) {
        poolAddresses.add(row.origin_address);
      }
    }
    return Object.freeze({
      ready: true, reason: null, swapCoverageComplete: true,
      completeThroughBlock: frontier.completeThroughBlock,
      swaps: Object.freeze(swaps),
      poolAddresses: Object.freeze([...poolAddresses].sort()),
      routerAddresses: Object.freeze([...new Set(swaps.map(({ routerAddress }) => (
        routerAddress
      )).filter(Boolean))].sort()),
      walletAddresses: Object.freeze([...new Set(swaps.map(({ walletAddress }) => (
        walletAddress
      )))].sort()),
    });
  }

  async function loadRangeContext(input = {}) {
    return readRangeContext(input, await loadSwapFrontier());
  }

  async function loadBackfillRangeContext(input = {}) {
    return readRangeContext(input, await loadBackfillFrontier());
  }

  return Object.freeze({
    listTrackedTokenAddresses, loadBackfillFrontier, loadBackfillPlan, loadBackfillRangeContext,
    loadRangeContext, loadSwapFrontier,
  });
}

module.exports = {
  MAX_IDENTITIES,
  createRobinhoodWalletTransferLiveSourceRepository,
  __private: { backfillFrontier, seedFrontier, sourceFrontier, transferBackfillPlan },
};
