/**
 * Robinhood transaction sender adapter.
 *
 * Pure, network-free adapter that turns a full block (as returned by
 * `eth_getBlockByNumber(n, true)`) into the signing EOA (`transaction.from`)
 * indexed by transaction hash, plus the block's onchain time.
 *
 * This is the missing piece for wallet attribution: swap logs only carry
 * router/recipient addresses, never the signer. The signer lives on the
 * transaction, so the wallet-swaps worker fetches the block with full
 * transactions and uses this adapter to resolve `from` per swap.
 *
 * It performs no I/O. The worker injects the RPC client and passes the raw
 * block object in, keeping this unit-testable with fixtures.
 */
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

// Inlined (identical to evm-log-poller.parseQuantity) so this adapter and the
// standalone seed runner carry no dependency on shared RPC utilities that may
// diverge in the node host's checkout.
function parseQuantity(value, label = 'quantity') {
  if (typeof value === 'bigint') return value;
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a decimal or hex quantity`);
  }
  return BigInt(raw);
}

function normalizeAddress(value, label = 'address') {
  const address = String(value ?? '').toLowerCase();
  if (!ADDRESS_RE.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function normalizeTxHash(value, label = 'transactionHash') {
  const hash = String(value ?? '').toLowerCase();
  if (!TX_HASH_RE.test(hash)) throw new Error(`${label} must be a 32-byte hex hash`);
  return hash;
}

function blockTimeIso(timestamp) {
  const timestampMs = Number(timestamp * 1000n);
  if (!Number.isSafeInteger(timestampMs)) throw new Error('block.timestamp is unsafe');
  return new Date(timestampMs).toISOString();
}

function indexedTransaction(tx, arrayIndex, blockNumber, blockHash) {
  const hash = normalizeTxHash(tx?.hash, 'transaction.hash');
  const from = normalizeAddress(tx?.from, 'transaction.from');
  const transactionIndex = tx?.transactionIndex == null
    ? BigInt(arrayIndex)
    : parseQuantity(tx.transactionIndex, 'transaction.transactionIndex');
  if (transactionIndex !== BigInt(arrayIndex)) {
    throw new Error(`transaction ${hash} index conflicts with its block position`);
  }
  return {
    hash,
    from,
    position: {
      transactionHash: hash,
      blockNumber: blockNumber.toString(),
      blockHash,
      transactionIndex: transactionIndex.toString(),
    },
  };
}

/**
 * Index a full block into signer and canonical transaction-position maps.
 *
 * Throws when the block was fetched without full transactions (an array of
 * hash strings), when a transaction is malformed, or when the block number
 * does not match `options.expectedBlockNumber` (a reorg/wrong-block guard).
 */
function indexBlockSenders(block, options = {}) {
  const blockNumber = parseQuantity(block?.number, 'block.number');
  const blockHash = normalizeTxHash(block?.hash, 'block.hash');
  if (options.expectedBlockNumber != null) {
    const expected = parseQuantity(options.expectedBlockNumber, 'expectedBlockNumber');
    if (blockNumber !== expected) {
      throw new Error(`block.number ${blockNumber} does not match expected ${expected}`);
    }
  }
  const blockTime = blockTimeIso(parseQuantity(block?.timestamp, 'block.timestamp'));

  const transactions = block?.transactions;
  if (!Array.isArray(transactions)) {
    throw new Error('block.transactions must be an array of full transactions');
  }
  if (transactions.length > 0 && typeof transactions[0] !== 'object') {
    throw new Error(
      'block.transactions contains hashes, not full transactions '
      + '(fetch the block with fullTransactions=true)'
    );
  }

  const senders = new Map();
  const positions = new Map();
  for (const [arrayIndex, tx] of transactions.entries()) {
    const { hash, from, position } = indexedTransaction(
      tx, arrayIndex, blockNumber, blockHash
    );
    const existing = senders.get(hash);
    if (existing !== undefined && existing !== from) {
      throw new Error(`transaction ${hash} has conflicting senders in the same block`);
    }
    senders.set(hash, from);
    positions.set(hash, position);
  }
  return { blockNumber, blockHash, blockTime, senders, positions };
}

/**
 * Resolve the signer for a specific set of transaction hashes present in the
 * block. Returns { blockNumber, blockHash, blockTime, resolved, missing } where `resolved`
 * maps hash -> signer and `missing` lists hashes not found in the block (which
 * signals a wrong block or reorg to the caller, not a silent drop).
 */
function resolveSenders(block, transactionHashes, options = {}) {
  const {
    blockNumber, blockHash, blockTime, senders, positions,
  } = indexBlockSenders(block, options);
  const resolved = new Map();
  const resolvedPositions = new Map();
  const missing = [];
  for (const raw of transactionHashes || []) {
    const hash = normalizeTxHash(raw, 'transactionHash');
    if (senders.has(hash)) {
      resolved.set(hash, senders.get(hash));
      resolvedPositions.set(hash, positions.get(hash));
    }
    else if (!resolved.has(hash)) missing.push(hash);
  }
  return { blockNumber, blockHash, blockTime, resolved, resolvedPositions, missing };
}

module.exports = {
  indexBlockSenders,
  resolveSenders,
  __private: { normalizeAddress, normalizeTxHash, blockTimeIso },
};
