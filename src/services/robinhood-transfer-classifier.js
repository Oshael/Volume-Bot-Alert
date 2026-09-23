const CLASSIFICATION_VERSION = 'rh_transfer_v1';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

function value(input, camel, snake = camel) {
  return input?.[camel] ?? input?.[snake];
}

function address(input, label) {
  const normalized = String(input ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be a 20-byte address`);
  return normalized;
}

function hash(input, label) {
  const normalized = String(input ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a 32-byte hash`);
  return normalized;
}

function uint(input, label) {
  const normalized = String(input ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function optionalAddress(input, label) {
  return input == null || input === '' ? null : address(input, label);
}

function addressSet(input, label) {
  if (input == null) return new Set();
  if (!Array.isArray(input) && !(input instanceof Set)) throw new Error(`${label} must be a list`);
  return new Set([...input].map((item) => address(item, label)));
}

function contractProofs(input) {
  if (input == null) return new Map();
  if (!Array.isArray(input)) throw new TypeError('contractRoleEvidence must be a list');
  return new Map(input.filter((proof) => (
    proof.evidenceBlock != null && proof.evidenceBlockHash != null
  )).map((proof) => {
    const endpoint = address(proof.endpointAddress, 'contract endpoint');
    const block = BigInt(uint(proof.evidenceBlock, 'evidenceBlock'));
    const blockHash = hash(proof.evidenceBlockHash, 'evidenceBlockHash');
    return [endpoint, { block, blockHash }];
  }));
}

function provenContractPair(transfer, input, swaps, proofs, wallets) {
  const rawBlock = value(input, 'blockNumber', 'block_number');
  if (!/^\d+$/.test(String(rawBlock ?? ''))) return false;
  const block = BigInt(rawBlock);
  const blockHash = String(value(input, 'blockHash', 'block_hash') ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) return false;
  const endpoints = [transfer.fromWallet, transfer.toWallet];
  if (endpoints.some((endpoint) => wallets.has(endpoint) || swaps.some((swap) => (
    endpoint === swap.walletAddress || endpoint === swap.recipientAddress
  )))) return false;
  return endpoints.every((endpoint) => {
    const proof = proofs.get(endpoint);
    return proof && block === proof.block && blockHash === proof.blockHash;
  });
}

function normalizeTransfer(input = {}) {
  return {
    transactionHash: hash(value(input, 'transactionHash', 'transaction_hash'), 'transactionHash'),
    logIndex: uint(value(input, 'logIndex', 'log_index'), 'logIndex'),
    tokenAddress: address(value(input, 'tokenAddress', 'token_address'), 'tokenAddress'),
    fromWallet: address(value(input, 'fromWallet', 'from_wallet'), 'fromWallet'),
    toWallet: address(value(input, 'toWallet', 'to_wallet'), 'toWallet'),
    amountRaw: uint(value(input, 'amountRaw', 'amount_raw'), 'amountRaw'),
  };
}

function normalizeSwap(input = {}) {
  const side = String(input.side || '').trim().toLowerCase();
  if (!['buy', 'sell'].includes(side)) throw new Error('swap side must be buy or sell');
  return {
    transactionHash: hash(value(input, 'transactionHash', 'transaction_hash'), 'swap transactionHash'),
    actionIndex: uint(value(input, 'actionIndex', 'action_index'), 'swap actionIndex'),
    tokenAddress: address(value(input, 'tokenAddress', 'token_address'), 'swap tokenAddress'),
    walletAddress: address(value(input, 'walletAddress', 'wallet_address'), 'swap walletAddress'),
    recipientAddress: optionalAddress(
      value(input, 'recipientAddress', 'recipient_address'), 'swap recipientAddress'
    ),
    amountRaw: uint(value(input, 'tokenAmountRaw', 'token_amount_raw'), 'swap tokenAmountRaw'),
    side,
  };
}

function matchesSwapDirection(transfer, swap) {
  if (swap.side === 'sell') return transfer.fromWallet === swap.walletAddress;
  const recipients = new Set([swap.walletAddress, swap.recipientAddress].filter(Boolean));
  return recipients.has(transfer.toWallet);
}

function matchesSwap(transfer, swap) {
  return transfer.logIndex !== swap.actionIndex && transfer.amountRaw === swap.amountRaw
    && matchesSwapDirection(transfer, swap);
}

function decision(kind, reasonCode, options = {}) {
  const selfTransfer = options.selfTransfer === true;
  const walletTransfer = kind === 'wallet_transfer' && !selfTransfer;
  return Object.freeze({
    kind,
    classificationVersion: CLASSIFICATION_VERSION,
    reasonCode,
    confidence: options.confidence || 'evidence_backed',
    duplicateOfSwap: kind === 'dex_flow',
    affectsPosition: walletTransfer,
    connectionEligible: walletTransfer,
    matchedSwap: options.matchedSwap ? Object.freeze({ ...options.matchedSwap }) : null,
    swapCorrelationFailure: options.swapCorrelationFailure || null,
  });
}

// Normaliza os swaps UMA vez e agrupa por (transactionHash, tokenAddress). O
// mesmo array e reusado para todos os transfers do batch, entao normalizar 1x
// (em vez de T x) elimina o custo O(T x S) que dominava a CPU. A ordem de
// entrada e preservada dentro de cada grupo -> saida identica ao filtro antigo.
function buildSwapIndex(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) throw new Error('swaps must be a list');
  const index = new Map();
  for (const raw of input) {
    const swap = normalizeSwap(raw);
    const key = `${swap.transactionHash}:${swap.tokenAddress}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(swap);
    else index.set(key, [swap]);
  }
  return index;
}

function decideSwapFlow(transfer, sameAssetSwaps) {
  if (!sameAssetSwaps || sameAssetSwaps.length === 0) return null;
  const distinctActions = sameAssetSwaps.filter((swap) => transfer.logIndex !== swap.actionIndex);
  const matches = distinctActions.filter((swap) => matchesSwap(transfer, swap));
  if (matches.length !== 1) {
    const swapCorrelationFailure = matches.length > 1 ? 'multiple_exact_matches'
      : distinctActions.length === 0 ? 'same_log_index_only'
        : distinctActions.some((swap) => matchesSwapDirection(transfer, swap))
          ? 'amount_mismatch' : 'direction_mismatch';
    return decision('unknown', 'swap_correlation_ambiguous', {
      confidence: 'ambiguous', swapCorrelationFailure,
    });
  }
  const match = matches[0];
  return decision('dex_flow', 'matched_wallet_swap', {
    matchedSwap: {
      transactionHash: match.transactionHash,
      actionIndex: match.actionIndex,
      side: match.side,
      logOrder: BigInt(transfer.logIndex) < BigInt(match.actionIndex)
        ? 'before_swap' : 'after_swap',
    },
  });
}

function classifySwapFlow(transfer, input) {
  const index = buildSwapIndex(input);
  const sameAssetSwaps = index && index.get(`${transfer.transactionHash}:${transfer.tokenAddress}`);
  return decideSwapFlow(transfer, sameAssetSwaps || null);
}

function createRobinhoodTransferClassifier(options = {}) {
  const pools = addressSet(options.poolAddresses, 'poolAddresses');
  const routers = addressSet(options.routerAddresses, 'routerAddresses');
  const contracts = addressSet(options.contractAddresses, 'contractAddresses');
  const wallets = addressSet(options.walletAddresses, 'walletAddresses');
  const proofs = contractProofs(options.contractRoleEvidence);
  const burns = addressSet(options.burnAddresses, 'burnAddresses');
  burns.add(ZERO_ADDRESS);
  burns.add(DEAD_ADDRESS);

  // memo do indice de swaps por referencia do array (estavel dentro de um batch)
  let cachedSwapsRef;
  let cachedSwapIndex = null;
  let cacheArmed = false;

  function swapIndex(swaps) {
    if (cacheArmed && swaps === cachedSwapsRef) return cachedSwapIndex;
    cachedSwapsRef = swaps;
    cachedSwapIndex = buildSwapIndex(swaps);
    cacheArmed = true;
    return cachedSwapIndex;
  }

  function classifyKnownFlow(transfer) {
    if (pools.has(transfer.fromWallet) || pools.has(transfer.toWallet)) {
      return decision('liquidity_flow', 'known_pool_endpoint');
    }
    if (routers.has(transfer.fromWallet) || routers.has(transfer.toWallet)) {
      return decision('router_flow', 'known_router_endpoint');
    }
    if (contracts.has(transfer.fromWallet) || contracts.has(transfer.toWallet)) {
      return decision('contract_flow', 'known_contract_endpoint');
    }
    if (wallets.has(transfer.fromWallet) && wallets.has(transfer.toWallet)) {
      const selfTransfer = transfer.fromWallet === transfer.toWallet;
      return selfTransfer
        ? decision('wallet_self', 'wallet_self_transfer', { selfTransfer: true })
        : decision('wallet_transfer', 'known_wallet_pair');
    }
    return decision('unknown', 'endpoint_types_unproven', { confidence: 'insufficient_evidence' });
  }

  function classify(input = {}, context = {}) {
    const transfer = normalizeTransfer(input);
    if (transfer.fromWallet === ZERO_ADDRESS) {
      return decision('mint', 'zero_address_sender', { confidence: 'deterministic' });
    }
    if (burns.has(transfer.toWallet)) {
      return decision('burn', 'burn_address_recipient', { confidence: 'deterministic' });
    }

    if (context.swapCoverageComplete !== true) {
      return decision('unknown', 'swap_coverage_unproven', {
        confidence: 'insufficient_evidence',
      });
    }
    const index = swapIndex(context.swaps);
    const sameAssetSwaps = index && index.get(`${transfer.transactionHash}:${transfer.tokenAddress}`);
    const swapFlow = decideSwapFlow(transfer, sameAssetSwaps || null);
    if (swapFlow?.kind === 'unknown' && provenContractPair(
      transfer, input, sameAssetSwaps, proofs, wallets
    )) {
      return decision('contract_flow', 'proven_contract_pair_swap_ambiguous');
    }
    if (swapFlow) return swapFlow;
    return classifyKnownFlow(transfer);
  }

  return Object.freeze({ classify });
}

module.exports = {
  CLASSIFICATION_VERSION,
  createRobinhoodTransferClassifier,
  __private: { classifySwapFlow, matchesSwap, normalizeSwap, normalizeTransfer },
};
