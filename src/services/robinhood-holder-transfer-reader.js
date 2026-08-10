const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');

const EXPECTED_CHAIN_ID = 4663n;
const MAX_RANGE_BLOCKS = 5000n;

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
  if (tokenAddress !== context.tokenAddress) throw new Error('Transfer log token does not match filter');
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  if (topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) {
    throw new Error('Transfer log topics are invalid');
  }
  const blockNumber = quantity(log.blockNumber, 'log.blockNumber');
  if (blockNumber < context.fromBlock || blockNumber > context.toBlock) {
    throw new Error('Transfer log is outside requested range');
  }
  const blockHash = hex(log.blockHash, 32, 'log.blockHash');
  if (blockNumber === context.toBlock && blockHash !== context.checkpointHash) {
    throw new Error('Transfer log conflicts with range checkpoint');
  }
  const amount = hex(log.data, 32, 'log.data');
  return Object.freeze({
    blockNumber: blockNumber.toString(), blockHash,
    transactionHash: hex(log.transactionHash, 32, 'log.transactionHash'),
    transactionIndex: index(log.transactionIndex, 'log.transactionIndex'),
    logIndex: index(log.logIndex, 'log.logIndex'), tokenAddress,
    fromWallet: topicAddress(topics[1], 'log.from'),
    toWallet: topicAddress(topics[2], 'log.to'),
    amountRaw: BigInt(amount).toString(),
  });
}

function isAdaptiveRangeError(error) {
  return ['log_range_error', 'timeout', 'rate_limited'].includes(error?.code)
    || (error?.code === 'http_error' && [400, 408, 413, 429].includes(error.httpStatus));
}

function createRobinhoodHolderTransferReader(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new TypeError('holder transfer RPC is required');
  let chainValidation;

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

  async function readLogs(fromBlock, toBlock, tokenAddress, telemetry) {
    telemetry.requests += 1;
    try {
      const logs = await rpcClient.request('eth_getLogs', [{
        address: tokenAddress, fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock),
        topics: [TRANSFER_TOPIC],
      }]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs result must be an array');
      return logs;
    } catch (error) {
      if (!isAdaptiveRangeError(error) || fromBlock >= toBlock) throw error;
      telemetry.splits += 1;
      const middle = (fromBlock + toBlock) / 2n;
      const left = await readLogs(fromBlock, middle, tokenAddress, telemetry);
      const right = await readLogs(middle + 1n, toBlock, tokenAddress, telemetry);
      return [...left, ...right];
    }
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
    const confirmations = boundedInteger(value, 12, 0, 1000, 'confirmations');
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
    const transfers = logs.map((log) => decodeTransferLog(log, context)).sort((left, right) => (
      BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1
        : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1
          : left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex
    ));
    const identities = new Set(transfers.map(({ transactionHash, logIndex }) => (
      `${transactionHash}:${logIndex}`
    )));
    if (identities.size !== transfers.length) throw new Error('holder replay returned duplicate logs');
    return Object.freeze({
      tokenAddress, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      nextBlock: (toBlock + 1n).toString(),
      checkpoint: Object.freeze({ number: toBlock.toString(), hash: checkpointHash }),
      transfers: Object.freeze(transfers), telemetry: Object.freeze(telemetry),
    });
  }

  return Object.freeze({ assertChain, getSafeHead, matchesCheckpoint, readBlock, readRange });
}

module.exports = {
  EXPECTED_CHAIN_ID,
  MAX_RANGE_BLOCKS,
  createRobinhoodHolderTransferReader,
  __private: { decodeTransferLog },
};
