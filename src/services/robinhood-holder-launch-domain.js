const LAUNCH_EVIDENCE_VERSION = 'rh_launch_v2';

function uint(value, label, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function address(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be an address`);
  return normalized;
}

function hash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a hash`);
  return normalized;
}

function instant(value, label) {
  const timestamp = Date.parse(String(value ?? '').trim());
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO instant`);
  return new Date(timestamp).toISOString();
}

function optionalDecimal(value, label) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`${label} must be non-negative`);
  return normalized;
}

function swap(input = {}) {
  const side = String(input.side || '').trim().toLowerCase();
  if (!['buy', 'sell'].includes(side)) throw new Error(`Unsupported swap side: ${side}`);
  return Object.freeze({
    walletAddress: address(input.walletAddress ?? input.wallet_address, 'walletAddress'),
    transactionHash: hash(input.transactionHash ?? input.transaction_hash, 'transactionHash'),
    actionIndex: uint(input.actionIndex ?? input.action_index, 'actionIndex'),
    transactionIndex: uint(
      input.transactionIndex ?? input.transaction_index, 'transactionIndex', true
    ),
    blockNumber: uint(input.blockNumber ?? input.block_number, 'blockNumber'),
    blockHash: hash(input.blockHash ?? input.block_hash, 'blockHash'),
    blockTime: instant(input.blockTime ?? input.block_time, 'blockTime'),
    side,
    volumeUsd: optionalDecimal(input.volumeUsd ?? input.volume_usd, 'volumeUsd'),
  });
}

function compareCanonical(left, right) {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  const transaction = BigInt(left.transactionIndex) - BigInt(right.transactionIndex);
  if (transaction !== 0n) return transaction < 0n ? -1 : 1;
  const action = BigInt(left.actionIndex) - BigInt(right.actionIndex);
  if (action !== 0n) return action < 0n ? -1 : 1;
  return left.transactionHash.localeCompare(right.transactionHash);
}

function unavailable(reason, frontier = null) {
  return Object.freeze({ ready: false, reason, frontier, anchor: null });
}

function normalizeFrontier(input = {}) {
  return Object.freeze({
    blockNumber: uint(input.blockNumber ?? input.block_number, 'frontier.blockNumber'),
    blockHash: hash(input.blockHash ?? input.block_hash, 'frontier.blockHash'),
  });
}

function deriveLaunchAnchor(input = {}) {
  if (input.coverageReady !== true) return unavailable('source_coverage_unavailable');
  const frontier = normalizeFrontier(input.frontier);
  if (!Array.isArray(input.swaps)) throw new TypeError('swaps must be a list');
  const eligible = input.swaps.map(swap).filter((item) => (
    BigInt(item.blockNumber) <= BigInt(frontier.blockNumber)
  ));
  if (!eligible.length) return unavailable('launch_swap_unavailable', frontier);
  const firstBlock = eligible.reduce((minimum, item) => (
    BigInt(item.blockNumber) < BigInt(minimum) ? item.blockNumber : minimum
  ), eligible[0].blockNumber);
  const candidates = eligible.filter(({ blockNumber }) => blockNumber === firstBlock);
  if (candidates.some(({ transactionIndex }) => transactionIndex == null)) {
    return unavailable('transaction_position_unavailable', frontier);
  }
  if (new Set(candidates.map(({ blockHash }) => blockHash)).size !== 1) {
    return unavailable('launch_block_incoherent', frontier);
  }
  const anchor = [...candidates].sort(compareCanonical)[0];
  return Object.freeze({
    ready: true,
    reason: null,
    frontier,
    anchor: Object.freeze({ ...anchor, evidenceVersion: LAUNCH_EVIDENCE_VERSION }),
  });
}

function windowLimit(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function firstByWallet(buys) {
  const result = new Map();
  for (const buy of buys.sort(compareCanonical)) {
    if (!result.has(buy.walletAddress)) result.set(buy.walletAddress, buy);
  }
  return [...result.values()];
}

function deriveFirstBuyEvidence(input = {}) {
  if (!input.anchorResult?.ready) {
    return Object.freeze({ ready: false, reason: 'launch_anchor_unavailable', records: [] });
  }
  if (!Array.isArray(input.swaps)) throw new TypeError('swaps must be a list');
  const maxBlocks = windowLimit(input.maxBlocks, 'maxBlocks');
  const maxSeconds = windowLimit(input.maxSeconds, 'maxSeconds');
  const anchor = input.anchorResult.anchor;
  const frontierBlock = BigInt(input.anchorResult.frontier.blockNumber);
  const buys = input.swaps.map(swap).filter(({ side, blockNumber }) => (
    side === 'buy' && BigInt(blockNumber) <= frontierBlock
  ));
  if (buys.some(({ transactionIndex }) => transactionIndex == null)) {
    return Object.freeze({ ready: false, reason: 'transaction_position_unavailable', records: [] });
  }
  if (buys.some((buy) => compareCanonical(buy, anchor) < 0)) {
    throw new Error('buy position precedes the launch anchor');
  }
  const anchorTime = Date.parse(anchor.blockTime);
  const records = firstByWallet(buys).map((buy, index) => {
    const deltaBlocks = BigInt(buy.blockNumber) - BigInt(anchor.blockNumber);
    const deltaMilliseconds = Date.parse(buy.blockTime) - anchorTime;
    if (deltaMilliseconds < 0) throw new Error('buy blockTime precedes the launch anchor');
    const deltaSeconds = Math.floor(deltaMilliseconds / 1000);
    return Object.freeze({
      ...buy,
      evidenceVersion: LAUNCH_EVIDENCE_VERSION,
      buyerRank: index + 1,
      deltaBlocks: deltaBlocks.toString(),
      deltaSeconds,
      withinLaunchWindow: deltaBlocks <= BigInt(maxBlocks) || deltaSeconds <= maxSeconds,
    });
  });
  return Object.freeze({ ready: true, reason: null, records: Object.freeze(records) });
}

module.exports = {
  LAUNCH_EVIDENCE_VERSION,
  compareCanonical,
  deriveFirstBuyEvidence,
  deriveLaunchAnchor,
};
