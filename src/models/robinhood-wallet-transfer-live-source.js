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

function identityList(values, label, bytes) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be a list`);
  if (values.length > MAX_IDENTITIES) throw new RangeError(`${label} exceeds ${MAX_IDENTITIES}`);
  return [...new Set(values.map((value) => fixedHex(value, label, bytes)))];
}

function sourceFrontier(row) {
  if (!row) return Object.freeze({ ready: false, reason: 'swap_live_missing' });
  const base = {
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

  async function loadRangeContext(input = {}) {
    const fromBlock = blockNumber(input.fromBlock, 'fromBlock');
    const toBlock = blockNumber(input.toBlock, 'toBlock');
    if (BigInt(fromBlock) > BigInt(toBlock)) throw new Error('classification block range is inverted');
    const frontier = await loadSwapFrontier();
    if (!frontier.ready || BigInt(toBlock) > BigInt(frontier.completeThroughBlock)) {
      return Object.freeze({
        ready: false,
        reason: frontier.ready ? 'swap_coverage_incomplete' : frontier.reason,
        completeThroughBlock: frontier.completeThroughBlock || null,
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

  return Object.freeze({ listTrackedTokenAddresses, loadRangeContext, loadSwapFrontier });
}

module.exports = {
  MAX_IDENTITIES,
  createRobinhoodWalletTransferLiveSourceRepository,
  __private: { sourceFrontier },
};
