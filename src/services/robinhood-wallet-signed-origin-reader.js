const EXPECTED_CHAIN_ID = 4663n;
const MAX_DATE_MS = 8_640_000_000_000_000n;

function invalid(message, code = 'signed_origin_rpc_invalid') {
  return Object.assign(new Error(message), { code });
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) {
    throw invalid(`${label} must be a canonical hex quantity`);
  }
  return BigInt(normalized);
}

function fixedHex(value, bytes, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw invalid(`${label} is invalid`);
  }
  return normalized;
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function decimal(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw invalid(`${label} must be an unsigned integer`);
  return BigInt(normalized);
}

function parseBlock(block, expectedNumber) {
  const blockNumber = quantity(block?.number, 'block.number');
  if (blockNumber !== expectedNumber) throw invalid('RPC returned the wrong block');
  const blockHash = fixedHex(block.hash, 32, 'block.hash');
  const timestampMs = quantity(block.timestamp, 'block.timestamp') * 1000n;
  if (timestampMs > MAX_DATE_MS) throw invalid('block.timestamp is unsafe');
  if (!Array.isArray(block.transactions)) throw invalid('full block transactions are unavailable');
  const blockTime = new Date(Number(timestampMs)).toISOString();
  const transactions = block.transactions.map((transaction, index) => {
    if (typeof transaction !== 'object' || transaction == null) {
      throw invalid('full transaction body is unavailable');
    }
    const transactionIndex = quantity(transaction.transactionIndex, 'transaction.transactionIndex');
    if (transactionIndex > 2_147_483_647n || transactionIndex !== BigInt(index)
        || quantity(transaction.blockNumber, 'transaction.blockNumber') !== blockNumber
        || fixedHex(transaction.blockHash, 32, 'transaction.blockHash') !== blockHash) {
      throw invalid('transaction position does not match its block');
    }
    return Object.freeze({
      walletAddress: fixedHex(transaction.from, 20, 'transaction.from'),
      transactionHash: fixedHex(transaction.hash, 32, 'transaction.hash'),
      transactionIndex: transactionIndex.toString(),
      nonce: quantity(transaction.nonce, 'transaction.nonce').toString(),
      blockNumber: blockNumber.toString(), blockHash, blockTime,
    });
  });
  return Object.freeze({
    number: blockNumber.toString(), hash: blockHash, blockTime,
    transactionCount: transactions.length, transactions: Object.freeze(transactions),
  });
}

async function parallelMap(values, concurrency, operation) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index]);
    }
  }));
  return output;
}

function boundedInteger(value, label, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function readerLimits(options) {
  const rpcBatchSize = boundedInteger(options.rpcBatchSize ?? 20, 'rpcBatchSize', 1, 50);
  return {
    rpcBatchSize,
    concurrency: boundedInteger(options.concurrency ?? 2, 'concurrency', 1, 8),
    maxBlocks: boundedInteger(options.maxBlocks ?? 100, 'maxBlocks', rpcBatchSize, 500),
    timeoutMs: boundedInteger(options.timeoutMs ?? 15_000, 'timeoutMs', 100, 60_000),
    maxPayloadBytes: boundedInteger(
      options.maxPayloadBytes ?? 64 * 1024 * 1024,
      'maxPayloadBytes', 256, Number.MAX_SAFE_INTEGER
    ),
  };
}

function createRobinhoodWalletSignedOriginReader(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function' || typeof rpcClient?.requestBatch !== 'function') {
    throw new TypeError('signed-origin RPC client with batch support is required');
  }
  const { rpcBatchSize, concurrency, maxBlocks, timeoutMs, maxPayloadBytes } = readerLimits(options);
  const now = options.now || Date.now;
  let chainValidation;

  async function assertChain() {
    chainValidation ||= rpcClient.request('eth_chainId').then((value) => {
      if (quantity(value, 'eth_chainId') !== EXPECTED_CHAIN_ID) {
        throw invalid('RPC is not Robinhood Chain', 'configuration_error');
      }
    }).catch((error) => { chainValidation = null; throw error; });
    return chainValidation;
  }

  async function requestChunk(numbers) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(invalid('full-block RPC timed out',
        'signed_origin_rpc_timeout')), timeoutMs);
    });
    try {
      const blocks = await Promise.race([
        rpcClient.requestBatch(numbers.map((number) => ({
          method: 'eth_getBlockByNumber', params: [blockTag(number), true],
        }))), timeout,
      ]);
      if (!Array.isArray(blocks) || blocks.length !== numbers.length) {
        throw invalid('RPC batch response length is invalid');
      }
      const payloadBytes = Buffer.byteLength(JSON.stringify(blocks));
      if (payloadBytes > maxPayloadBytes) throw invalid('RPC payload exceeds configured limit');
      return { blocks, payloadBytes };
    } finally { clearTimeout(timer); }
  }

  async function readBlocks(input = {}) {
    const numbers = (input.blockNumbers || []).map((value) => decimal(value, 'blockNumber'));
    if (!numbers.length || numbers.length > maxBlocks) throw invalid('block batch size is invalid');
    for (let index = 1; index < numbers.length; index += 1) {
      if (numbers[index] !== numbers[index - 1] + 1n) throw invalid('blocks must be contiguous');
    }
    const coverageOrigin = decimal(input.coverageOriginBlock, 'coverageOriginBlock');
    const safeHead = decimal(input.safeHead, 'safeHead');
    if (coverageOrigin > numbers[0]) throw invalid('coverage origin follows the requested batch');
    if (numbers.at(-1) > safeHead) throw invalid('requested batch exceeds the safe head');
    if (!['seed', 'live'].includes(input.stream)) throw invalid('stream is invalid');
    await assertChain();
    const startedAt = now();
    const chunks = [];
    for (let index = 0; index < numbers.length; index += rpcBatchSize) {
      chunks.push(numbers.slice(index, index + rpcBatchSize));
    }
    const responses = await parallelMap(chunks, concurrency, requestChunk);
    const payloadBytes = responses.reduce((sum, item) => sum + item.payloadBytes, 0);
    if (payloadBytes > maxPayloadBytes) throw invalid('RPC payload exceeds configured limit');
    const blocks = responses.flatMap(({ blocks: values }) => values)
      .map((block, index) => parseBlock(block, numbers[index]));
    const origins = new Map();
    const transactionHashes = new Set();
    for (const block of blocks) for (const transaction of block.transactions) {
      if (transactionHashes.has(transaction.transactionHash)) {
        throw invalid('transaction hash is duplicated across the block batch');
      }
      transactionHashes.add(transaction.transactionHash);
      if (!origins.has(transaction.walletAddress)) origins.set(transaction.walletAddress, {
        ...transaction, coverageOriginBlock: coverageOrigin.toString(),
        sourceStream: input.stream, observedAt: new Date(now()).toISOString(),
      });
    }
    const elapsedMs = Math.max(1, now() - startedAt);
    return Object.freeze({
      blocks: Object.freeze(blocks.map((block) => Object.freeze({
        number: block.number, hash: block.hash, blockTime: block.blockTime,
        transactionCount: block.transactionCount,
      }))),
      origins: Object.freeze([...origins.values()].map(Object.freeze)),
      metrics: Object.freeze({
        blocksScanned: blocks.length,
        transactionsScanned: blocks.reduce((sum, block) => sum + block.transactionCount, 0),
        originsFound: origins.size, payloadBytes, elapsedMs,
        blocksPerSecond: Number(((blocks.length * 1000) / elapsedMs).toFixed(2)),
      }),
    });
  }

  return Object.freeze({ assertChain, readBlocks });
}

module.exports = { createRobinhoodWalletSignedOriginReader, __private: { parseBlock } };
