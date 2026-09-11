'use strict';

const DEFAULT_MAX_DEPTH = 64;
const MAX_DEPTH = 1000;
const ROLLBACK_MANIFEST_VERSION = 2;

const ROLLBACK_DOMAINS = Object.freeze([
  Object.freeze({
    id: 'canonical-journal', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_chain_blocks', 'robinhood_chain_transactions',
      'robinhood_chain_events', 'robinhood_chain_v3_balance_snapshots',
      'robinhood_chain_domain_outbox', 'robinhood_canonical_head_candidates',
      'robinhood_token_deployment_outbox', 'robinhood_chain_capture_cursor',
    ]),
  }),
  Object.freeze({
    id: 'market', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_head_captures', 'robinhood_processed_logs',
      'robinhood_market_observations', 'robinhood_market_buckets_1m',
      'robinhood_market_buckets_1h', 'robinhood_market_buckets_agg',
      'robinhood_derived_outbox', 'robinhood_v4_liquidity_deltas',
    ]),
  }),
  Object.freeze({
    id: 'wallet', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_wallet_swaps', 'robinhood_wallet_swap_cursors',
      'robinhood_wallet_token_positions', 'robinhood_wallet_position_cursors',
      'robinhood_transaction_positions',
    ]),
  }),
  Object.freeze({
    id: 'wallet-derived', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_token_transfer_events',
      'robinhood_wallet_transfer_edges', 'robinhood_wallet_transfer_cursors',
      'robinhood_wallet_signed_origins', 'robinhood_wallet_signed_origin_cursors',
      'robinhood_wallet_token_first_buys', 'robinhood_first_buy_live_cursors',
    ]),
  }),
  Object.freeze({
    id: 'liquidity', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_pool_liquidity_snapshots', 'robinhood_pool_liquidity_event_cursors',
      'robinhood_pool_liquidity_refresh_queue',
    ]),
  }),
  Object.freeze({
    id: 'holders', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_holder_transfer_journal', 'robinhood_holder_balances',
      'robinhood_holder_token_states', 'robinhood_holder_cursors',
      'robinhood_token_holder_buckets', 'robinhood_holder_distribution_metrics',
      'robinhood_holder_classifications', 'robinhood_holder_classification_states',
      'robinhood_holder_hot_queue',
    ]),
  }),
  Object.freeze({
    id: 'discovery-creator', rollbackRegistered: false,
    tables: Object.freeze([
      'robinhood_pool_registry', 'token_catalog', 'robinhood_token_attributions',
      'robinhood_direct_creator_cursors', 'robinhood_token_launch_anchors',
      'robinhood_launch_anchor_outbox',
    ]),
  }),
  Object.freeze({
    id: 'publication-alerts', rollbackRegistered: true,
    tables: Object.freeze([
      'robinhood_wallet_swap_outbox', 'robinhood_wallet_swap_realtime_outbox',
      'user_alert_events', 'telegram_alert_deliveries',
    ]),
  }),
]);

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}
function hash(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}
function boundedDepth(value) {
  const parsed = Number(value ?? DEFAULT_MAX_DEPTH);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DEPTH) {
    throw new Error(`maxDepth must be between 1 and ${MAX_DEPTH}`);
  }
  return parsed;
}
function header(value, label) {
  return {
    blockNumber: quantity(
      value?.blockNumber ?? value?.block_number ?? value?.number, `${label}.blockNumber`
    ),
    blockHash: hash(value?.blockHash ?? value?.block_hash ?? value?.hash, `${label}.blockHash`),
  };
}
function pendingRollbackDomains() {
  return ROLLBACK_DOMAINS.filter((domain) => !domain.rollbackRegistered)
    .map((domain) => domain.id);
}
function rpcTag(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}
async function remoteHeader(rpcClient, blockNumber) {
  const value = await rpcClient.request('eth_getBlockByNumber', [rpcTag(blockNumber), false]);
  if (!value) {
    const error = new Error(`canonical RPC has no header for block ${blockNumber}`);
    error.code = 'capture_recovery_header_unavailable';
    throw error;
  }
  const result = header(value, 'rpcHeader');
  if (result.blockNumber !== blockNumber) {
    const error = new Error(`canonical RPC returned unexpected block ${result.blockNumber}`);
    error.code = 'capture_recovery_source_changed';
    throw error;
  }
  return { ...result, parentHash: hash(value.parentHash, 'rpcHeader.parentHash') };
}
function basePlan(cursor, incoming, maxDepth) {
  const checkpoint = header({
    blockNumber: cursor.checkpoint_block, blockHash: cursor.checkpoint_hash,
  }, 'cursor.checkpoint');
  const pendingDomains = pendingRollbackDomains();
  return {
    generation: quantity(cursor.generation, 'cursor.generation').toString(),
    maxDepth,
    checkpoint: {
      blockNumber: checkpoint.blockNumber.toString(), blockHash: checkpoint.blockHash,
    },
    incoming: {
      blockNumber: incoming.blockNumber.toString(), blockHash: incoming.blockHash,
      parentHash: incoming.parentHash,
    },
    finalizedBoundary: cursor.finalized_head == null ? null
      : { blockNumber: quantity(cursor.finalized_head, 'cursor.finalizedHead').toString() },
    rollbackManifestVersion: ROLLBACK_MANIFEST_VERSION,
    pendingRollbackDomains: pendingDomains,
    executable: pendingDomains.length === 0,
  };
}
function completePlan(base, ancestor) {
  const finalized = base.finalizedBoundary == null
    ? null : BigInt(base.finalizedBoundary.blockNumber);
  const crossesFinalized = finalized != null && ancestor.blockNumber < finalized;
  const depth = BigInt(base.checkpoint.blockNumber) - ancestor.blockNumber;
  return {
    ...base,
    reason: crossesFinalized ? 'finalized_boundary_crossed' : 'parent_hash_mismatch',
    recoverable: !crossesFinalized,
    ancestor: {
      blockNumber: ancestor.blockNumber.toString(), blockHash: ancestor.blockHash,
    },
    affectedRange: {
      fromBlock: (ancestor.blockNumber + 1n).toString(),
      throughBlock: base.checkpoint.blockNumber,
      depth: depth.toString(),
    },
  };
}

function createRobinhoodChainRecoveryPlanner(deps, options = {}) {
  const maxDepth = boundedDepth(options.maxDepth);
  async function plan(input = {}) {
    const cursor = input.cursor || await deps.journal.getCursor();
    if (!cursor?.checkpoint_hash || cursor.checkpoint_block == null) {
      throw new Error('capture recovery requires an initialized checkpoint');
    }
    const incoming = {
      ...header(input.incoming, 'incoming'),
      parentHash: hash(input.incoming?.parentHash, 'incoming.parentHash'),
    };
    const checkpointNumber = quantity(cursor.checkpoint_block, 'cursor.checkpointBlock');
    if (incoming.blockNumber !== checkpointNumber + 1n) {
      throw new Error('incoming block must immediately follow the checkpoint');
    }
    if (incoming.parentHash === String(cursor.checkpoint_hash).toLowerCase()) {
      return { status: 'extends-checkpoint', recoveryRequired: false, plan: null };
    }
    const lowerBound = checkpointNumber > BigInt(maxDepth)
      ? checkpointNumber - BigInt(maxDepth) : 0n;
    const local = await deps.journal.listCanonicalHeaders({
      fromBlock: lowerBound.toString(), throughBlock: checkpointNumber.toString(),
      limit: maxDepth + 1,
    });
    const localByNumber = new Map(local.map((value) => {
      const normalized = header(value, 'localHeader');
      return [normalized.blockNumber.toString(), normalized];
    }));
    const base = basePlan(cursor, incoming, maxDepth);
    let expectedRemoteHash = incoming.parentHash;
    for (let number = checkpointNumber; number >= lowerBound; number -= 1n) {
      const localHeader = localByNumber.get(number.toString());
      if (!localHeader) break;
      const remote = await remoteHeader(deps.rpcClient, number);
      if (remote.blockHash !== expectedRemoteHash) {
        const error = new Error('canonical RPC changed while recovery was being planned');
        error.code = 'capture_recovery_source_changed';
        throw error;
      }
      if (remote.blockHash === localHeader.blockHash) {
        return { status: 'recovery-required', recoveryRequired: true,
          plan: completePlan(base, localHeader) };
      }
      expectedRemoteHash = remote.parentHash;
    }
    return { status: 'recovery-required', recoveryRequired: true, plan: {
      ...base, reason: 'ancestor_not_found', recoverable: false,
      ancestor: null, affectedRange: null,
    } };
  }
  return Object.freeze({ plan });
}

module.exports = {
  DEFAULT_MAX_DEPTH, MAX_DEPTH, ROLLBACK_DOMAINS, ROLLBACK_MANIFEST_VERSION,
  createRobinhoodChainRecoveryPlanner,
  __private: { boundedDepth, pendingRollbackDomains },
};
