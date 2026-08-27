const EXPECTED_CHAIN_ID = 4663n;
const SAFETY_FACTOR = 1.25;
const MAX_HOURS = 5;
const RESPONSE_TOO_LARGE_RPC_CODE = -32003;
const TRANSACTION_BATCH_SIZE = 25;

function quantity(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) {
    throw new Error(`${label} must be a canonical hex quantity`);
  }
  return BigInt(normalized);
}

function address(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function hash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function parseBlock(block, expectedNumber, candidateWallets) {
  if (quantity(block?.number, 'block.number') !== BigInt(expectedNumber)) {
    throw new Error(`archive returned the wrong block for ${expectedNumber}`);
  }
  const blockHash = hash(block.hash, 'block.hash');
  const blockTimestamp = quantity(block.timestamp, 'block.timestamp').toString();
  if (!Array.isArray(block.transactions)) throw new Error('full block transactions are unavailable');
  const transfers = [];
  let candidateInboundTransfers = 0;
  let candidateOutboundTransfers = 0;
  for (const transaction of block.transactions) {
    const value = quantity(transaction?.value, 'transaction.value');
    if (value === 0n || transaction.to == null) continue;
    const from = address(transaction.from, 'transaction.from');
    const to = address(transaction.to, 'transaction.to');
    if (candidateWallets.has(to)) candidateInboundTransfers += 1;
    if (candidateWallets.has(from)) candidateOutboundTransfers += 1;
    transfers.push(Object.freeze({
      transactionHash: hash(transaction.hash, 'transaction.hash'),
      transactionIndex: quantity(transaction.transactionIndex, 'transaction.transactionIndex').toString(),
      fromAddress: from, toAddress: to, valueWei: value.toString(),
      blockNumber: String(expectedNumber), blockHash, blockTimestamp,
    }));
  }
  return { transfers, candidateInboundTransfers, candidateOutboundTransfers };
}

function responseTooLarge(error) {
  return error?.code === 'rpc_error' && error.rpcCode === RESPONSE_TOO_LARGE_RPC_CODE;
}

function validateHydratedTransaction(transaction, transactionHash, block) {
  if (!transaction || hash(transaction.hash, 'transaction.hash') !== transactionHash) {
    throw new Error(`archive omitted transaction ${transactionHash}`);
  }
  if (quantity(transaction.blockNumber, 'transaction.blockNumber')
      !== quantity(block.number, 'block.number')
      || hash(transaction.blockHash, 'transaction.blockHash')
        !== hash(block.hash, 'block.hash')) {
    throw new Error(`archive returned transaction ${transactionHash} from the wrong block`);
  }
  return transaction;
}

function createRobinhoodBundleFundingReader(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function' || typeof rpcClient?.requestBatch !== 'function') {
    throw new Error('archive RPC client with batch support is required');
  }
  const candidateWallets = new Set((options.candidateWallets || []).map((value) => (
    address(value, 'candidateWallet')
  )));

  async function assertChain() {
    const chainId = quantity(await rpcClient.request('eth_chainId'), 'eth_chainId');
    if (chainId !== EXPECTED_CHAIN_ID) {
      throw new Error(`archive chain ID ${chainId} does not match Robinhood ${EXPECTED_CHAIN_ID}`);
    }
    return chainId.toString();
  }

  async function checkpoint(blockNumber) {
    const block = await rpcClient.request('eth_getBlockByNumber', [blockTag(blockNumber), false]);
    if (quantity(block?.number, 'checkpoint.number') !== BigInt(blockNumber)) {
      throw new Error('archive checkpoint block mismatch');
    }
    return hash(block.hash, 'checkpoint.hash');
  }

  async function hydrateOversizedBlock(blockNumber) {
    const block = await rpcClient.request(
      'eth_getBlockByNumber', [blockTag(blockNumber), false]
    );
    if (quantity(block?.number, 'block.number') !== BigInt(blockNumber)) {
      throw new Error(`archive returned the wrong block for ${blockNumber}`);
    }
    hash(block.hash, 'block.hash');
    if (!Array.isArray(block.transactions)) {
      throw new Error('block transaction hashes are unavailable');
    }
    const transactionHashes = block.transactions.map((value) => hash(
      value, 'block transaction hash'
    ));
    const transactions = [];
    for (let offset = 0; offset < transactionHashes.length; offset += TRANSACTION_BATCH_SIZE) {
      const batch = transactionHashes.slice(offset, offset + TRANSACTION_BATCH_SIZE);
      const hydrated = await rpcClient.requestBatch(batch.map((transactionHash) => ({
        method: 'eth_getTransactionByHash', params: [transactionHash],
      })));
      transactions.push(...hydrated.map((transaction, index) => (
        validateHydratedTransaction(transaction, batch[index], block)
      )));
    }
    return { ...block, transactions };
  }

  async function readFullBlock(blockNumber) {
    try {
      return await rpcClient.request(
        'eth_getBlockByNumber', [blockTag(blockNumber), true]
      );
    } catch (error) {
      if (!responseTooLarge(error)) throw error;
      return hydrateOversizedBlock(blockNumber);
    }
  }

  async function readBlocks(blockNumbers) {
    let blocks;
    try {
      blocks = await rpcClient.requestBatch(blockNumbers.map((number) => ({
        method: 'eth_getBlockByNumber', params: [blockTag(number), true],
      })));
    } catch (error) {
      if (!responseTooLarge(error)) throw error;
      blocks = [];
      for (const blockNumber of blockNumbers) blocks.push(await readFullBlock(blockNumber));
    }
    const parsed = blocks.map((block, index) => (
      parseBlock(block, blockNumbers[index], candidateWallets)
    ));
    return Object.freeze({
      blocksScanned: blocks.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(blocks)),
      transfers: Object.freeze(parsed.flatMap(({ transfers }) => transfers)),
      candidateInboundTransfers: parsed.reduce((sum, item) => (
        sum + item.candidateInboundTransfers
      ), 0),
      candidateOutboundTransfers: parsed.reduce((sum, item) => (
        sum + item.candidateOutboundTransfers
      ), 0),
    });
  }
  return Object.freeze({ assertChain, checkpoint, readBlocks });
}

function sampleBatches(ranges, batchBlocks, sampleCount) {
  const chunks = [];
  for (const range of ranges) {
    const from = BigInt(range.fromBlock);
    const through = BigInt(range.toBlock);
    for (let start = from; start <= through; start += BigInt(batchBlocks)) {
      const end = start + BigInt(batchBlocks - 1);
      chunks.push({ from: start, through: end < through ? end : through });
    }
  }
  const wanted = Math.min(sampleCount, chunks.length);
  const indexes = new Set(Array.from({ length: wanted }, (_, index) => (
    wanted === 1 ? 0 : Math.round((index * (chunks.length - 1)) / (wanted - 1))
  )));
  return Object.freeze({
    batchCount: chunks.length,
    samples: Object.freeze([...indexes].map((index) => {
      const { from, through } = chunks[index];
      return Object.freeze(Array.from(
        { length: Number(through - from + 1n) }, (_, offset) => (from + BigInt(offset)).toString()
      ));
    })),
  });
}

async function parallelMap(values, concurrency, operation) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]);
    }
  }));
  return output;
}

function preflightOptions(input) {
  const batchBlocks = Number(input.batchBlocks ?? 50);
  const concurrency = Number(input.concurrency ?? 8);
  const sampleCount = Number(input.sampleCount ?? 16);
  const maxHours = Number(input.maxHours ?? MAX_HOURS);
  if (!Number.isSafeInteger(batchBlocks) || batchBlocks < 1 || batchBlocks > 100) {
    throw new Error('batchBlocks must be between 1 and 100');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('concurrency must be between 1 and 16');
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < concurrency || sampleCount > 64) {
    throw new Error('sampleCount must be between concurrency and 64');
  }
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > MAX_HOURS) {
    throw new Error(`maxHours must be greater than 0 and at most ${MAX_HOURS}`);
  }
  return { batchBlocks, concurrency, sampleCount, maxHours };
}

async function preflightBundleFunding(input = {}, deps = {}) {
  const { reader } = deps;
  const { batchBlocks, concurrency, sampleCount, maxHours } = preflightOptions(input);
  const workload = sampleBatches(input.ranges, batchBlocks, sampleCount);
  if (!workload.batchCount) throw new Error('funding scan has no ranges');
  const chainId = await reader.assertChain();
  const initialHash = await reader.checkpoint(input.sourceThroughBlock);
  const now = deps.now || Date.now;
  const startedAt = now();
  const observations = await parallelMap(workload.samples, concurrency, reader.readBlocks);
  const elapsedMs = Math.max(1, now() - startedAt);
  const finalHash = await reader.checkpoint(input.sourceThroughBlock);
  const sampledBlocks = observations.reduce((sum, value) => sum + value.blocksScanned, 0);
  const projectedMs = Math.ceil(
    (elapsedMs * workload.batchCount * SAFETY_FACTOR) / observations.length
  );
  const total = (key) => observations.reduce((sum, value) => sum + value[key], 0);
  const checkpointCanonical = initialHash === finalHash;
  return Object.freeze({
    chainId, sourceThroughBlock: String(input.sourceThroughBlock),
    sourceThroughHash: initialHash, checkpointCanonical,
    batchBlocks, batchCount: workload.batchCount, concurrency,
    sampleCount: observations.length, sampledBlocks, elapsedMs,
    samplePayloadBytes: total('payloadBytes'),
    sampleNativeTransfers: observations.reduce((sum, value) => sum + value.transfers.length, 0),
    sampleCandidateInboundTransfers: total('candidateInboundTransfers'),
    sampleCandidateOutboundTransfers: total('candidateOutboundTransfers'),
    safetyFactor: SAFETY_FACTOR, maxHours, projectedMs,
    projectedHours: Number((projectedMs / 3_600_000).toFixed(2)),
    approved: checkpointCanonical && projectedMs <= maxHours * 3_600_000,
  });
}

module.exports = {
  EXPECTED_CHAIN_ID, createRobinhoodBundleFundingReader, preflightBundleFunding,
  __private: { parseBlock, responseTooLarge, sampleBatches },
};
