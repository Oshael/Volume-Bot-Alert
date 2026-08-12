const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');

const EXPECTED_CHAIN_ID = 4663n;
const MAX_RANGE_BLOCKS = 5000n;
const MAX_RECEIPT_RANGE_BLOCKS = 1000n;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function hex(value, bytes, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function address(value, label) {
  return hex(value, 20, label);
}

function index(value, label) {
  const parsed = quantity(value, label);
  if (parsed > 2_147_483_647n) throw new Error(`${label} exceeds PostgreSQL integer`);
  return Number(parsed);
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function topicAddress(value, label) {
  const topic = hex(value, 32, label);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) throw new Error(`${label} is not an address topic`);
  return `0x${topic.slice(-40)}`;
}

function decodeTransferLog(log, context) {
  if (log?.removed === true) throw new Error('Transfer log is marked removed');
  const tokenAddress = address(log?.address, 'log.address');
  if (context.tokenAddress && tokenAddress !== context.tokenAddress) {
    throw new Error('Transfer log token does not match filter');
  }
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) {
    throw new Error('Transfer log topics are invalid');
  }
  if (topics.length !== 3) {
    const error = new Error('Transfer log topics are invalid');
    error.code = 'holder_transfer_invalid_log';
    error.tokenAddress = tokenAddress;
    throw error;
  }
  const blockNumber = quantity(log.blockNumber, 'log.blockNumber');
  if (blockNumber < context.fromBlock || blockNumber > context.toBlock) {
    throw new Error('Transfer log is outside requested range');
  }
  const blockHash = hex(log.blockHash, 32, 'log.blockHash');
  if (blockNumber === context.toBlock && blockHash !== context.checkpointHash) {
    throw new Error('Transfer log conflicts with range checkpoint');
  }
  let amount;
  let fromWallet;
  let toWallet;
  try {
    amount = hex(log.data, 32, 'log.data');
    fromWallet = topicAddress(topics[1], 'log.from');
    toWallet = topicAddress(topics[2], 'log.to');
  } catch (error) {
    error.code = 'holder_transfer_invalid_log';
    error.tokenAddress = tokenAddress;
    throw error;
  }
  return Object.freeze({
    blockNumber: blockNumber.toString(), blockHash,
    transactionHash: hex(log.transactionHash, 32, 'log.transactionHash'),
    transactionIndex: index(log.transactionIndex, 'log.transactionIndex'),
    logIndex: index(log.logIndex, 'log.logIndex'), tokenAddress,
    fromWallet, toWallet,
    amountRaw: BigInt(amount).toString(),
  });
}

function orderTransfers(logs, context) {
  const transfers = logs.map((log) => decodeTransferLog(log, context)).sort((left, right) => (
    BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1
      : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1
        : left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex
  ));
  const identities = new Set(transfers.map(({ transactionHash, logIndex }) => (
    `${transactionHash}:${logIndex}`
  )));
  if (identities.size !== transfers.length) throw new Error('holder replay returned duplicate logs');
  return Object.freeze(transfers);
}

function isAdaptiveRangeError(error) {
  return ['log_range_error', 'timeout', 'rate_limited'].includes(error?.code)
    || (error?.code === 'http_error' && [400, 408, 413, 429].includes(error.httpStatus));
}

function isAdaptiveAddressError(error) {
  return (error?.code === 'http_error' && [400, 413].includes(error.httpStatus))
    || (error?.code === 'rpc_error' && error.rpcCode === -32602)
    || error?.code === 'timeout';
}

function createRobinhoodHolderTransferReader(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new TypeError('holder transfer RPC is required');
  const addressShardConcurrency = boundedInteger(
    options.addressShardConcurrency, 1, 1, 4, 'addressShardConcurrency'
  );
  let chainValidation;
  let learnedAddressLimit = null;

  async function assertChain() {
    if (!chainValidation) {
      chainValidation = rpcClient.request('eth_chainId').then((value) => {
        const chainId = quantity(value, 'eth_chainId');
        if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`unexpected Robinhood chain ID ${chainId}`);
        return chainId.toString();
      }).catch((error) => {
        chainValidation = null;
        throw error;
      });
    }
    return chainValidation;
  }

  async function readLogs(fromBlock, toBlock, tokenFilter, telemetry) {
    telemetry.requests += 1;
    try {
      const filter = {
        fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock), topics: [TRANSFER_TOPIC],
      };
      if (tokenFilter) filter.address = tokenFilter;
      const logs = await rpcClient.request('eth_getLogs', [filter]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs result must be an array');
      return logs;
    } catch (error) {
      if (Array.isArray(tokenFilter) && tokenFilter.length > 1
          && isAdaptiveAddressError(error)) {
        telemetry.addressSplits += 1;
        const middle = Math.ceil(tokenFilter.length / 2);
        learnedAddressLimit = learnedAddressLimit == null
          ? middle : Math.min(learnedAddressLimit, middle);
        const left = await readAddressFilteredLogs(
          fromBlock, toBlock, tokenFilter.slice(0, middle), telemetry
        );
        const right = await readAddressFilteredLogs(
          fromBlock, toBlock, tokenFilter.slice(middle), telemetry
        );
        return [...left, ...right];
      }
      if (!isAdaptiveRangeError(error) || fromBlock >= toBlock) throw error;
      telemetry.splits += 1;
      const middle = (fromBlock + toBlock) / 2n;
      const left = await readLogs(fromBlock, middle, tokenFilter, telemetry);
      const right = await readLogs(middle + 1n, toBlock, tokenFilter, telemetry);
      return [...left, ...right];
    }
  }

  async function readAddressFilteredLogs(fromBlock, toBlock, addresses, telemetry) {
    const limit = learnedAddressLimit || addresses.length;
    const logs = [];
    const batchWidth = limit * addressShardConcurrency;
    for (let offset = 0; offset < addresses.length; offset += batchWidth) {
      const pending = [];
      const through = Math.min(addresses.length, offset + batchWidth);
      for (let shard = offset; shard < through; shard += limit) {
        pending.push(readLogs(
          fromBlock, toBlock, addresses.slice(shard, shard + limit), telemetry
        ));
      }
      const resolved = await Promise.all(pending);
      for (const shardLogs of resolved) logs.push(...shardLogs);
    }
    return logs;
  }

  async function readBlock(value) {
    const number = quantity(value, 'block.number');
    await assertChain();
    const block = await rpcClient.request('eth_getBlockByNumber', [blockTag(number), false]);
    if (quantity(block?.number, 'block.number') !== number) {
      throw new Error('RPC block does not match requested number');
    }
    return Object.freeze({ number: number.toString(), hash: hex(block?.hash, 32, 'block.hash') });
  }

  async function getSafeHead(value = 12) {
    const confirmations = boundedInteger(value, 12, 0, 100_000, 'confirmations');
    await assertChain();
    const head = quantity(await rpcClient.request('eth_blockNumber'), 'eth_blockNumber');
    const safeHead = head >= BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
    return Object.freeze({ head: head.toString(), safeHead: safeHead.toString(), confirmations });
  }

  async function matchesCheckpoint(checkpoint = {}) {
    const expectedHash = hex(checkpoint.hash, 32, 'checkpoint.hash');
    const block = await readBlock(checkpoint.number);
    return block.hash === expectedHash;
  }

  async function readRange(input = {}) {
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const toBlock = quantity(input.toBlock, 'toBlock');
    if (fromBlock > toBlock) throw new Error('holder replay range is inverted');
    if (toBlock - fromBlock + 1n > MAX_RANGE_BLOCKS) {
      throw new Error(`holder replay range exceeds ${MAX_RANGE_BLOCKS} blocks`);
    }
    await assertChain();
    const telemetry = { requests: 0, splits: 0 };
    const [logs, checkpoint] = await Promise.all([
      readLogs(fromBlock, toBlock, tokenAddress, telemetry),
      readBlock(toBlock),
    ]);
    const checkpointHash = checkpoint.hash;
    const context = { tokenAddress, fromBlock, toBlock, checkpointHash };
    const transfers = orderTransfers(logs, context);
    return Object.freeze({
      tokenAddress, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      nextBlock: (toBlock + 1n).toString(),
      checkpoint: Object.freeze({ number: toBlock.toString(), hash: checkpointHash }),
      transfers: Object.freeze(transfers), telemetry: Object.freeze(telemetry),
    });
  }

  async function readReceiptRange(input = {}) {
    if (typeof rpcClient.requestBatch !== 'function') {
      throw new TypeError('holder receipt RPC batch support is required');
    }
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const toBlock = quantity(input.toBlock, 'toBlock');
    const batchSize = boundedInteger(input.batchSize, 25, 1, 100, 'receipt batchSize');
    if (fromBlock > toBlock) throw new Error('holder receipt range is inverted');
    if (toBlock - fromBlock + 1n > MAX_RECEIPT_RANGE_BLOCKS) {
      throw new Error(`holder receipt range exceeds ${MAX_RECEIPT_RANGE_BLOCKS} blocks`);
    }
    await assertChain();
    const blockCount = Number(toBlock - fromBlock + 1n);
    const requests = Array.from({ length: blockCount }, (_, offset) => ({
      method: 'eth_getBlockReceipts', params: [blockTag(fromBlock + BigInt(offset))],
    }));
    const observedLogs = [];
    let receiptCount = 0;
    let requestCount = 0;
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      requestCount += 1;
      const batch = requests.slice(offset, offset + batchSize);
      const results = await rpcClient.requestBatch(batch);
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error('eth_getBlockReceipts batch is invalid');
      }
      for (const receipts of results) {
        if (!Array.isArray(receipts)) throw new Error('eth_getBlockReceipts result is invalid');
        receiptCount += receipts.length;
        for (const receipt of receipts) {
          if (!Array.isArray(receipt?.logs)) throw new Error('receipt logs are invalid');
          observedLogs.push(...receipt.logs);
        }
      }
    }
    const checkpoint = await readBlock(toBlock);
    const logs = observedLogs.filter((log) => (
      String(log?.address || '').toLowerCase() === tokenAddress
      && String(log?.topics?.[0] || '').toLowerCase() === TRANSFER_TOPIC
    ));
    const context = { tokenAddress, fromBlock, toBlock, checkpointHash: checkpoint.hash };
    return Object.freeze({
      tokenAddress, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      nextBlock: (toBlock + 1n).toString(), checkpoint,
      transfers: orderTransfers(logs, context),
      telemetry: Object.freeze({
        requests: requestCount, receiptBlocks: blockCount, receipts: receiptCount,
        observedLogs: observedLogs.length, ignoredLogs: observedLogs.length - logs.length,
      }),
    });
  }

  async function readGlobalRange(input = {}) {
    if (!Array.isArray(input.tokenAddresses)) throw new TypeError('tokenAddresses must be an array');
    const allowed = new Set(input.tokenAddresses.map((value) => address(value, 'tokenAddress')));
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const toBlock = quantity(input.toBlock, 'toBlock');
    if (fromBlock > toBlock) throw new Error('holder live range is inverted');
    if (toBlock - fromBlock + 1n > MAX_RANGE_BLOCKS) {
      throw new Error(`holder live range exceeds ${MAX_RANGE_BLOCKS} blocks`);
    }
    await assertChain();
    const telemetry = { requests: 0, splits: 0, addressSplits: 0 };
    const [observedLogs, checkpoint] = await Promise.all([
      allowed.size ? readAddressFilteredLogs(fromBlock, toBlock, [...allowed], telemetry) : [],
      readBlock(toBlock),
    ]);
    const logs = observedLogs.filter((log) => allowed.has(String(log?.address || '').toLowerCase()));
    const context = { tokenAddress: null, fromBlock, toBlock, checkpointHash: checkpoint.hash };
    return Object.freeze({
      fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      nextBlock: (toBlock + 1n).toString(), scopeTokens: allowed.size,
      checkpoint, transfers: orderTransfers(logs, context),
      telemetry: Object.freeze({
        ...telemetry, observedLogs: observedLogs.length,
        ignoredLogs: observedLogs.length - logs.length,
      }),
    });
  }

  return Object.freeze({
    assertChain, getSafeHead, matchesCheckpoint, readBlock,
    readGlobalRange, readRange, readReceiptRange,
  });
}

module.exports = {
  EXPECTED_CHAIN_ID,
  MAX_RANGE_BLOCKS,
  MAX_RECEIPT_RANGE_BLOCKS,
  createRobinhoodHolderTransferReader,
  __private: { decodeTransferLog },
};
