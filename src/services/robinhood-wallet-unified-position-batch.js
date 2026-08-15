const { applyWalletPositionEvent } = require('./robinhood-wallet-position-domain');

const UNIFIED_POSITION_VERSION = 'unified_transfer_v1';

function value(input, camel, snake = camel) {
  return input?.[camel] ?? input?.[snake];
}

function fixedHex(input, label, bytes) {
  const normalized = String(input ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function uint(input, label) {
  const normalized = String(input ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function pairKey(tokenAddress, walletAddress) {
  return `${tokenAddress}:${walletAddress}`;
}

function compareEvents(left, right) {
  for (const field of ['blockNumber', 'transactionIndex', 'logIndex']) {
    const difference = BigInt(left[field]) - BigInt(right[field]);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return left.eventOrder - right.eventOrder
    || left.walletAddress.localeCompare(right.walletAddress);
}

function transactionPositions(transfers) {
  const positions = new Map();
  for (const transfer of transfers) {
    const transactionHash = fixedHex(
      value(transfer, 'transactionHash', 'transaction_hash'), 'transfer transactionHash', 32
    );
    const position = {
      blockNumber: uint(value(transfer, 'blockNumber', 'block_number'), 'transfer blockNumber'),
      transactionIndex: uint(
        value(transfer, 'transactionIndex', 'transaction_index'), 'transfer transactionIndex'
      ),
    };
    const current = positions.get(transactionHash);
    if (current && (current.blockNumber !== position.blockNumber
      || current.transactionIndex !== position.transactionIndex)) {
      throw new Error('transfer transaction position is inconsistent');
    }
    positions.set(transactionHash, position);
  }
  return positions;
}

function swapEvent(swap, positions) {
  const transactionHash = fixedHex(
    value(swap, 'transactionHash', 'transaction_hash'), 'swap transactionHash', 32
  );
  const blockNumber = uint(value(swap, 'blockNumber', 'block_number'), 'swap blockNumber');
  const captured = positions.get(transactionHash);
  const suppliedIndex = value(swap, 'transactionIndex', 'transaction_index');
  const transactionIndex = suppliedIndex == null
    ? captured?.transactionIndex : uint(suppliedIndex, 'swap transactionIndex');
  if (transactionIndex == null) throw new Error('swap transaction index is unavailable');
  if (captured && (captured.blockNumber !== blockNumber
    || captured.transactionIndex !== transactionIndex)) {
    throw new Error('swap transaction position conflicts with captured transfers');
  }
  const side = String(swap.side ?? '').trim().toLowerCase();
  if (!['buy', 'sell'].includes(side)) throw new Error('swap side must be buy or sell');
  const volumeUsd = value(swap, 'volumeUsd', 'volume_usd');
  if (volumeUsd == null) throw new Error('swap volumeUsd is required');
  return Object.freeze({
    source: 'swap', type: side, eventOrder: 0,
    blockNumber, transactionIndex,
    logIndex: uint(value(swap, 'actionIndex', 'action_index'), 'swap actionIndex'),
    transactionHash,
    tokenAddress: fixedHex(value(swap, 'tokenAddress', 'token_address'), 'swap tokenAddress', 20),
    walletAddress: fixedHex(value(swap, 'walletAddress', 'wallet_address'), 'swap walletAddress', 20),
    amountRaw: uint(value(swap, 'tokenAmountRaw', 'token_amount_raw'), 'swap tokenAmountRaw'),
    volumeUsd: String(volumeUsd),
    marketCapUsd: value(swap, 'marketCapUsd', 'market_cap_usd') == null
      ? null : String(value(swap, 'marketCapUsd', 'market_cap_usd')),
  });
}

function transferEvents(transfer) {
  if (String(value(transfer, 'transferKind', 'transfer_kind')) !== 'wallet_transfer') return [];
  if (value(transfer, 'affectsPosition', 'affects_position') === false) return [];
  const amountRaw = uint(value(transfer, 'amountRaw', 'amount_raw'), 'transfer amountRaw');
  if (amountRaw === '0') return [];
  const fromWallet = fixedHex(
    value(transfer, 'fromWallet', 'from_wallet'), 'transfer fromWallet', 20
  );
  const toWallet = fixedHex(value(transfer, 'toWallet', 'to_wallet'), 'transfer toWallet', 20);
  if (fromWallet === toWallet) throw new Error('wallet self-transfer cannot adjust positions');
  const shared = {
    source: 'wallet_transfer',
    blockNumber: uint(value(transfer, 'blockNumber', 'block_number'), 'transfer blockNumber'),
    transactionIndex: uint(
      value(transfer, 'transactionIndex', 'transaction_index'), 'transfer transactionIndex'
    ),
    logIndex: uint(value(transfer, 'logIndex', 'log_index'), 'transfer logIndex'),
    transactionHash: fixedHex(
      value(transfer, 'transactionHash', 'transaction_hash'), 'transfer transactionHash', 32
    ),
    tokenAddress: fixedHex(
      value(transfer, 'tokenAddress', 'token_address'), 'transfer tokenAddress', 20
    ),
    amountRaw,
  };
  return [
    Object.freeze({ ...shared, type: 'transfer_out', eventOrder: 1, walletAddress: fromWallet }),
    Object.freeze({ ...shared, type: 'transfer_in', eventOrder: 2, walletAddress: toWallet }),
  ];
}

function storedPositions(input) {
  if (!Array.isArray(input)) throw new TypeError('positions must be a list');
  const positions = new Map();
  for (const position of input) {
    const tokenAddress = fixedHex(position.tokenAddress, 'position tokenAddress', 20);
    const walletAddress = fixedHex(position.walletAddress, 'position walletAddress', 20);
    const key = pairKey(tokenAddress, walletAddress);
    if (positions.has(key)) throw new Error('positions must be unique');
    positions.set(key, { ...position, tokenAddress, walletAddress });
  }
  return positions;
}

function applyEvent(positions, event, countedTransactions) {
  const key = pairKey(event.tokenAddress, event.walletAddress);
  const sideTransaction = event.source === 'swap'
    ? `${key}:${event.type}:${event.transactionHash}` : null;
  const next = applyWalletPositionEvent(positions.get(key) || {}, {
    type: event.type, amountRaw: event.amountRaw,
    ...(event.source === 'swap' ? {
      volumeUsd: event.volumeUsd, marketCapUsd: event.marketCapUsd,
      newSideTransaction: !countedTransactions.has(sideTransaction),
    } : {}),
  });
  if (sideTransaction) countedTransactions.add(sideTransaction);
  positions.set(key, {
    ...next, tokenAddress: event.tokenAddress, walletAddress: event.walletAddress,
    throughBlock: event.blockNumber, throughLogIndex: event.logIndex,
  });
  return key;
}

function buildRobinhoodWalletUnifiedPositionBatch(input = {}) {
  const transfers = input.transfers || [];
  const swaps = input.swaps || [];
  if (!Array.isArray(transfers) || !Array.isArray(swaps)) {
    throw new TypeError('swaps and transfers must be lists');
  }
  const positions = storedPositions(input.positions || []);
  const txPositions = transactionPositions(transfers);
  const events = [
    ...swaps.map((swap) => swapEvent(swap, txPositions)),
    ...transfers.flatMap(transferEvents),
  ].sort(compareEvents);
  const countedTransactions = new Set();
  const touched = new Set();
  for (const event of events) touched.add(applyEvent(positions, event, countedTransactions));
  return Object.freeze({
    projectionVersion: UNIFIED_POSITION_VERSION,
    positions: Object.freeze([...touched].sort().map((key) => Object.freeze(positions.get(key)))),
    telemetry: Object.freeze({
      swaps: swaps.length,
      walletTransfers: events.filter(({ source, type }) => (
        source === 'wallet_transfer' && type === 'transfer_out'
      )).length,
      financialEvents: events.length, touchedPositions: touched.size,
    }),
  });
}

module.exports = {
  UNIFIED_POSITION_VERSION,
  buildRobinhoodWalletUnifiedPositionBatch,
  __private: { compareEvents, transactionPositions },
};
