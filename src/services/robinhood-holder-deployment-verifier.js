const { normalizeTokenAddress } = require('../utils/token-identity');

const ROBINHOOD_CHAIN_ID = 4663n;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw evidenceError(`${label} is invalid`);
  }
  return BigInt(raw);
}

function fixedHex(value, bytes, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw evidenceError(`${label} is invalid`);
  }
  return normalized;
}

function evidenceError(message) {
  const error = new Error(message);
  error.code = 'holder_deployment_evidence_invalid';
  return error;
}

function address(value, label) {
  try { return normalizeTokenAddress('robinhood', value); }
  catch (_) { throw evidenceError(`${label} is invalid`); }
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function optionalAddress(value) {
  if (value == null) return null;
  try { return normalizeTokenAddress('robinhood', value); }
  catch (_) { return null; }
}

function normalizeHint(input = {}) {
  return Object.freeze({
    tokenAddress: address(input.tokenAddress, 'tokenAddress'),
    creatorAddress: address(input.creatorAddress, 'creatorAddress'),
    transactionHash: fixedHex(input.transactionHash, 32, 'transactionHash'),
  });
}

function validateTransaction(hint, transaction, receipt) {
  if (!transaction || !receipt) throw evidenceError('deployment transaction is unavailable');
  const transactionHash = fixedHex(transaction.hash, 32, 'transaction.hash');
  const receiptHash = fixedHex(receipt.transactionHash, 32, 'receipt.transactionHash');
  const creatorAddress = address(transaction.from, 'transaction.from');
  const contractAddress = receipt.contractAddress == null
    ? null : address(receipt.contractAddress, 'receipt.contractAddress');
  const transactionTo = transaction.to == null
    ? null : address(transaction.to, 'transaction.to');
  const transactionBlock = quantity(transaction.blockNumber, 'transaction.blockNumber');
  const receiptBlock = quantity(receipt.blockNumber, 'receipt.blockNumber');
  const transactionBlockHash = fixedHex(transaction.blockHash, 32, 'transaction.blockHash');
  const receiptBlockHash = fixedHex(receipt.blockHash, 32, 'receipt.blockHash');
  if (transactionHash !== hint.transactionHash || receiptHash !== hint.transactionHash
      || quantity(receipt.status, 'receipt.status') !== 1n
      || transactionBlock !== receiptBlock || transactionBlockHash !== receiptBlockHash) {
    throw evidenceError('deployment transaction diverged from its Blockscout hint');
  }
  return Object.freeze({
    blockNumber: receiptBlock.toString(), blockHash: receiptBlockHash,
    contractAddress, creatorAddress, direct: transactionTo === null,
  });
}

function parityCreation(entries, tokenAddress) {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!['create', 'create2'].includes(String(entry?.type || '').toLowerCase())) continue;
    if (optionalAddress(entry?.result?.address) !== tokenAddress) continue;
    const factoryAddress = optionalAddress(entry?.action?.from);
    if (factoryAddress) return factoryAddress;
  }
  return null;
}

function callTracerCreation(frame, tokenAddress) {
  if (!frame || typeof frame !== 'object') return null;
  const type = String(frame.type || '').toLowerCase();
  if (['create', 'create2'].includes(type) && optionalAddress(frame.to) === tokenAddress) {
    const factoryAddress = optionalAddress(frame.from);
    if (factoryAddress) return factoryAddress;
  }
  for (const child of Array.isArray(frame.calls) ? frame.calls : []) {
    const factoryAddress = callTracerCreation(child, tokenAddress);
    if (factoryAddress) return factoryAddress;
  }
  return null;
}

function creationKind(evidence, tokenAddress) {
  if (evidence.contractAddress === tokenAddress && evidence.direct) return 'direct';
  if ((evidence.contractAddress === null && !evidence.direct)
      || (evidence.contractAddress !== null
        && evidence.contractAddress !== tokenAddress && evidence.direct)) return 'internal';
  return null;
}

function parityBlockCreations(entries, tokenAddress) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!['create', 'create2'].includes(String(entry?.type || '').toLowerCase())
        || optionalAddress(entry?.result?.address) !== tokenAddress) return [];
    const factoryAddress = optionalAddress(entry?.action?.from);
    const transactionHash = String(entry?.transactionHash || '').toLowerCase();
    return factoryAddress && /^0x[0-9a-f]{64}$/.test(transactionHash)
      ? [{ factoryAddress, transactionHash }] : [];
  });
}

function debugBlockCreations(entries, transactions, tokenAddress) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry, index) => {
    const factoryAddress = callTracerCreation(entry?.result || entry, tokenAddress);
    const transactionHash = String(
      entry?.txHash || entry?.transactionHash || transactions?.[index]?.hash || ''
    ).toLowerCase();
    return factoryAddress && /^0x[0-9a-f]{64}$/.test(transactionHash)
      ? [{ factoryAddress, transactionHash }] : [];
  });
}

function oneCreation(matches) {
  const unique = [...new Map(matches.map((item) => [
    `${item.transactionHash}:${item.factoryAddress}`, item,
  ])).values()];
  if (unique.length > 1) throw evidenceError('deployment block trace is ambiguous');
  return unique[0] || null;
}

async function findBlockTraceCreation(rpcClient, tokenAddress, blockNumber) {
  const tag = blockTag(blockNumber);
  let parityError = null;
  try {
    const match = oneCreation(parityBlockCreations(
      await rpcClient.request('trace_block', [tag]), tokenAddress
    ));
    if (match) return match;
  } catch (error) { parityError = error; }
  let debugError = null;
  try {
    const [block, traces] = await Promise.all([
      rpcClient.request('eth_getBlockByNumber', [tag, true]),
      rpcClient.request('debug_traceBlockByNumber', [tag, { tracer: 'callTracer' }]),
    ]);
    const match = oneCreation(debugBlockCreations(traces, block?.transactions, tokenAddress));
    if (match) return match;
  } catch (error) { debugError = error; }
  if (parityError && debugError) {
    const parityCode = String(parityError.rpcCode ?? parityError.code ?? 'failed');
    const debugCode = String(debugError.rpcCode ?? debugError.code ?? 'failed');
    throw evidenceError(`deployment block trace RPC is unavailable (${parityCode}/${debugCode})`);
  }
  throw evidenceError('deployment block trace does not create the token contract');
}

async function resolveTraceFactory(rpcClient, hint) {
  let parityError = null;
  try {
    const traces = await rpcClient.request('trace_transaction', [hint.transactionHash]);
    const factoryAddress = parityCreation(traces, hint.tokenAddress);
    if (factoryAddress) return factoryAddress;
  } catch (error) { parityError = error; }
  let debugError = null;
  try {
    const trace = await rpcClient.request('debug_traceTransaction', [
      hint.transactionHash, { tracer: 'callTracer' },
    ]);
    const factoryAddress = callTracerCreation(trace, hint.tokenAddress);
    if (factoryAddress) return factoryAddress;
  } catch (error) { debugError = error; }
  if (parityError && debugError) {
    const parityCode = String(parityError.rpcCode ?? parityError.code ?? 'failed');
    const debugCode = String(debugError.rpcCode ?? debugError.code ?? 'failed');
    throw evidenceError(`deployment trace RPC is unavailable (${parityCode}/${debugCode})`);
  }
  throw evidenceError('deployment trace does not create the token contract');
}

function createRobinhoodHolderDeploymentVerifier(options = {}) {
  const rpcClient = options.rpcClient;
  const internalCreationLookup = options.internalCreationLookup;
  if (typeof rpcClient?.request !== 'function') {
    throw new TypeError('holder deployment verifier RPC client is required');
  }
  let chainValidation = null;

  async function validateChain() {
    chainValidation ||= Promise.resolve(rpcClient.request('eth_chainId')).then((value) => {
      if (quantity(value, 'chainId') !== ROBINHOOD_CHAIN_ID) {
        const error = new Error('holder deployment verifier RPC is not Robinhood Chain');
        error.code = 'configuration_error';
        throw error;
      }
    }).catch((error) => {
      chainValidation = null;
      throw error;
    });
    return chainValidation;
  }

  async function verifyDirectDeployment(input = {}) {
    const hint = normalizeHint(input);
    await validateChain();
    const [transaction, receipt] = await Promise.all([
      rpcClient.request('eth_getTransactionByHash', [hint.transactionHash]),
      rpcClient.request('eth_getTransactionReceipt', [hint.transactionHash]),
    ]);
    const evidence = validateTransaction(hint, transaction, receipt);
    let source = 'rpc_direct';
    let creatorAddress = hint.creatorAddress;
    let factoryAddress = null;
    if (evidence.contractAddress === hint.tokenAddress && evidence.direct) {
      if (evidence.creatorAddress !== hint.creatorAddress) {
        throw evidenceError('direct deployment creator diverged from its Blockscout hint');
      }
    } else if (evidence.contractAddress === null) {
      creatorAddress = evidence.creatorAddress;
      let internalLookupError = null;
      if (typeof internalCreationLookup === 'function') {
        try {
          const internal = await internalCreationLookup(hint);
          factoryAddress = optionalAddress(internal?.factoryAddress);
          if (factoryAddress) source = 'blockscout_internal';
        } catch (error) { internalLookupError = error; }
      }
      if (!factoryAddress) {
        source = 'rpc_trace';
        try { factoryAddress = await resolveTraceFactory(rpcClient, hint); }
        catch (error) { throw internalLookupError || error; }
      }
    } else {
      throw evidenceError('deployment transaction does not create the token contract');
    }
    const block = await rpcClient.request('eth_getBlockByNumber', [blockTag(evidence.blockNumber), false]);
    if (quantity(block?.number, 'block.number').toString() !== evidence.blockNumber
        || fixedHex(block?.hash, 32, 'block.hash') !== evidence.blockHash) {
      throw evidenceError('deployment receipt block is not canonical');
    }
    return Object.freeze({
      ...hint, creatorAddress, source, factoryAddress,
      blockNumber: evidence.blockNumber,
    });
  }

  async function verifyTransactionDeployment(input = {}) {
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const transactionHash = fixedHex(input.transactionHash, 32, 'transactionHash');
    const requestedBlock = quantity(input.blockNumber, 'blockNumber');
    const requestedHash = fixedHex(input.blockHash, 32, 'blockHash');
    await validateChain();
    const [transaction, receipt] = await Promise.all([
      rpcClient.request('eth_getTransactionByHash', [transactionHash]),
      rpcClient.request('eth_getTransactionReceipt', [transactionHash]),
    ]);
    const hint = {
      tokenAddress, transactionHash,
      creatorAddress: address(transaction?.from, 'transaction.from'),
    };
    const evidence = validateTransaction(hint, transaction, receipt);
    const kind = creationKind(evidence, tokenAddress);
    if (quantity(evidence.blockNumber, 'evidence.blockNumber') !== requestedBlock
        || evidence.blockHash !== requestedHash || !kind) {
      throw evidenceError('mint transaction does not prove the token creation');
    }
    const factoryAddress = kind === 'internal'
      ? await resolveTraceFactory(rpcClient, hint) : null;
    const block = await rpcClient.request('eth_getBlockByNumber', [blockTag(requestedBlock), false]);
    if (quantity(block?.number, 'block.number') !== requestedBlock
        || fixedHex(block?.hash, 32, 'block.hash') !== requestedHash) {
      throw evidenceError('mint transaction block is not canonical');
    }
    return Object.freeze({
      tokenAddress, creatorAddress: evidence.creatorAddress, transactionHash,
      source: kind === 'direct' ? 'rpc_direct' : 'rpc_trace', factoryAddress,
      blockNumber: requestedBlock.toString(),
    });
  }

  async function verifyBlockTraceDeployment(input = {}) {
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const requestedBlock = quantity(input.blockNumber, 'blockNumber');
    await validateChain();
    const creation = await findBlockTraceCreation(rpcClient, tokenAddress, requestedBlock);
    const hint = { tokenAddress, creatorAddress: creation.factoryAddress,
      transactionHash: creation.transactionHash };
    const [transaction, receipt] = await Promise.all([
      rpcClient.request('eth_getTransactionByHash', [creation.transactionHash]),
      rpcClient.request('eth_getTransactionReceipt', [creation.transactionHash]),
    ]);
    const evidence = validateTransaction(hint, transaction, receipt);
    const kind = creationKind(evidence, tokenAddress);
    if (quantity(evidence.blockNumber, 'evidence.blockNumber') !== requestedBlock
        || !kind) {
      throw evidenceError('deployment block trace does not prove the token creation');
    }
    const block = await rpcClient.request('eth_getBlockByNumber', [blockTag(requestedBlock), false]);
    if (quantity(block?.number, 'block.number') !== requestedBlock
        || fixedHex(block?.hash, 32, 'block.hash') !== evidence.blockHash) {
      throw evidenceError('deployment trace block is not canonical');
    }
    return Object.freeze({
      tokenAddress, creatorAddress: evidence.creatorAddress,
      transactionHash: creation.transactionHash,
      source: kind === 'direct' ? 'rpc_direct' : 'rpc_trace',
      factoryAddress: kind === 'direct' ? null : creation.factoryAddress,
      blockNumber: requestedBlock.toString(),
    });
  }

  return Object.freeze({
    verifyBlockTraceDeployment, verifyDirectDeployment, verifyTransactionDeployment,
  });
}

module.exports = {
  createRobinhoodHolderDeploymentVerifier,
  __private: {
    callTracerCreation, creationKind, debugBlockCreations, findBlockTraceCreation,
    normalizeHint, parityBlockCreations, parityCreation, validateTransaction,
  },
};
