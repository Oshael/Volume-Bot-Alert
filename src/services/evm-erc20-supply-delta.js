const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

function normalizeAddress(value) {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('token address must be 20-byte hex');
  return address;
}

function quantity(value, label) {
  const parsed = BigInt(String(value));
  if (parsed < 0n) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function blockTag(value) {
  return `0x${value.toString(16)}`;
}

function logIdentity(log) {
  return `${String(log.transactionHash || '').toLowerCase()}:${quantity(log.logIndex, 'log index')}`;
}

function decodeTransfer(log) {
  const topics = Array.isArray(log?.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [];
  const data = String(log?.data || '').toLowerCase();
  if (topics.length < 3 || topics[0] !== TRANSFER_TOPIC || !/^0x[0-9a-f]{64}$/.test(data)) {
    throw new Error('invalid ERC-20 Transfer log');
  }
  const amount = BigInt(data);
  const minted = topics[1] === ZERO_TOPIC ? amount : 0n;
  const burned = topics[2] === ZERO_TOPIC ? amount : 0n;
  return { minted, burned };
}

function isAdaptiveRangeError(error) {
  return error?.code === 'log_range_error'
    || error?.code === 'timeout'
    || error?.code === 'rate_limited'
    || (error?.code === 'http_error' && [400, 408, 413, 429].includes(error.httpStatus));
}

function createErc20SupplyDeltaReader(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;

  async function readLogs(filter) {
    try {
      const logs = await rpcClient.request('eth_getLogs', [filter]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs result must be an array');
      return logs;
    } catch (error) {
      const from = quantity(filter.fromBlock, 'fromBlock');
      const to = quantity(filter.toBlock, 'toBlock');
      if (!isAdaptiveRangeError(error) || from >= to) throw error;
      const middle = (from + to) / 2n;
      const [left, right] = await Promise.all([
        readLogs({ ...filter, toBlock: blockTag(middle) }),
        readLogs({ ...filter, fromBlock: blockTag(middle + 1n) }),
      ]);
      return [...left, ...right];
    }
  }

  async function getDelta(tokenAddress, range = {}) {
    const address = normalizeAddress(tokenAddress);
    const from = quantity(range.fromBlock, 'fromBlock');
    const to = quantity(range.toBlock, 'toBlock');
    if (from > to) return { usable: true, deltaRaw: '0', events: 0 };
    const common = { address, fromBlock: blockTag(from), toBlock: blockTag(to) };
    try {
      const [mintLogs, burnLogs] = await Promise.all([
        readLogs({ ...common, topics: [TRANSFER_TOPIC, ZERO_TOPIC] }),
        readLogs({ ...common, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC] }),
      ]);
      const unique = new Map([...mintLogs, ...burnLogs].map((log) => [logIdentity(log), log]));
      let delta = 0n;
      for (const log of unique.values()) {
        const transfer = decodeTransfer(log);
        delta += transfer.minted - transfer.burned;
      }
      return { usable: true, deltaRaw: delta.toString(), events: unique.size };
    } catch (_) {
      return { usable: false, deltaRaw: null, events: 0 };
    }
  }

  return Object.freeze({ getDelta });
}

module.exports = {
  TRANSFER_TOPIC,
  ZERO_TOPIC,
  createErc20SupplyDeltaReader,
};
