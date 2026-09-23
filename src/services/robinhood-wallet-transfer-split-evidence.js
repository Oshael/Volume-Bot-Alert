// Shadow-only evidence for a buy whose gross swap payout is split between the
// signing wallet and the token contract. A match is not a classification.
function value(row, camel, snake) { return row?.[camel] ?? row?.[snake]; }
function lower(input) { return String(input ?? '').toLowerCase(); }
function uint(input) {
  const normalized = String(input ?? '');
  if (!/^\d+$/.test(normalized)) throw new Error('split evidence requires unsigned integers');
  return BigInt(normalized);
}
function identity(row) {
  return `${lower(value(row, 'transactionHash', 'transaction_hash'))}:${lower(value(row, 'tokenAddress', 'token_address'))}`;
}
function grouped(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = identity(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function exactBuySplit(swap, transfers) {
  if (lower(swap.side) !== 'buy' || transfers.length !== 2
      || transfers.some((row) => value(row, 'transferKind', 'transfer_kind') !== 'unknown')) {
    return null;
  }
  const token = lower(value(swap, 'tokenAddress', 'token_address'));
  const wallet = lower(value(swap, 'walletAddress', 'wallet_address'));
  const walletLegs = transfers.filter((row) => lower(value(row, 'toWallet', 'to_wallet')) === wallet);
  if (walletLegs.length !== 1) return null;
  const walletLeg = walletLegs[0];
  const contractLeg = transfers.find((row) => row !== walletLeg);
  if (lower(value(contractLeg, 'toWallet', 'to_wallet')) !== token
      || lower(value(walletLeg, 'fromWallet', 'from_wallet'))
        !== lower(value(contractLeg, 'fromWallet', 'from_wallet'))) return null;
  const action = uint(value(swap, 'actionIndex', 'action_index'));
  const walletLog = uint(value(walletLeg, 'logIndex', 'log_index'));
  const contractLog = uint(value(contractLeg, 'logIndex', 'log_index'));
  const walletAmount = uint(value(walletLeg, 'amountRaw', 'amount_raw'));
  const contractAmount = uint(value(contractLeg, 'amountRaw', 'amount_raw'));
  if (walletLog === contractLog || walletLog >= action || contractLog >= action
      || walletAmount === 0n || contractAmount === 0n
      || walletAmount + contractAmount !== uint(value(swap, 'tokenAmountRaw', 'token_amount_raw'))) {
    return null;
  }
  return Object.freeze({
    transactionHash: lower(value(swap, 'transactionHash', 'transaction_hash')),
    tokenAddress: token, swapActionIndex: action.toString(),
    walletLogIndex: walletLog.toString(), contractLogIndex: contractLog.toString(),
    grossAmountRaw: (walletAmount + contractAmount).toString(),
    walletReceivedRaw: walletAmount.toString(), contractReceivedRaw: contractAmount.toString(),
  });
}

function findExactBuySplitEvidence(transfers = [], swaps = []) {
  if (!Array.isArray(transfers) || !Array.isArray(swaps)) {
    throw new TypeError('split evidence requires transfer and swap lists');
  }
  const byTransfer = grouped(transfers);
  const bySwap = grouped(swaps);
  const matches = [];
  for (const [key, relatedSwaps] of bySwap) {
    if (relatedSwaps.length !== 1) continue;
    const match = exactBuySplit(relatedSwaps[0], byTransfer.get(key) || []);
    if (match) matches.push(match);
  }
  return Object.freeze(matches);
}

module.exports = { findExactBuySplitEvidence };
