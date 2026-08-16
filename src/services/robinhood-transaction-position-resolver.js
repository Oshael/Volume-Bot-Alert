const {
  indexBlockSenders,
} = require('./robinhood-transaction-sender-adapter');

const MAX_BLOCK_BATCH_SIZE = 25;
const POSITION_WRITE_BATCH_SIZE = 5_000;

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

function boundedBatchSize(input) {
  const parsed = input == null ? 10 : Number(input);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BLOCK_BATCH_SIZE) {
    throw new Error(`blockBatchSize must be between 1 and ${MAX_BLOCK_BATCH_SIZE}`);
  }
  return parsed;
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function swapRequirements(swaps) {
  if (!Array.isArray(swaps)) throw new TypeError('swaps must be a list');
  const requirements = new Map();
  for (const swap of swaps) {
    const transactionHash = fixedHex(
      value(swap, 'transactionHash', 'transaction_hash'), 'swap transactionHash', 32
    );
    const blockNumber = uint(value(swap, 'blockNumber', 'block_number'), 'swap blockNumber');
    const rawIndex = value(swap, 'transactionIndex', 'transaction_index');
    const transactionIndex = rawIndex == null ? null : uint(rawIndex, 'swap transactionIndex');
    const current = requirements.get(transactionHash);
    if (current && (current.blockNumber !== blockNumber
      || (current.transactionIndex != null && transactionIndex != null
        && current.transactionIndex !== transactionIndex))) {
      throw new Error('swap transaction position evidence is inconsistent');
    }
    requirements.set(transactionHash, {
      transactionHash, blockNumber,
      transactionIndex: current?.transactionIndex ?? transactionIndex,
    });
  }
  return requirements;
}

function unresolvedBlocks(requirements) {
  const blocks = new Map();
  for (const requirement of requirements.values()) {
    if (requirement.transactionIndex != null) continue;
    if (!blocks.has(requirement.blockNumber)) blocks.set(requirement.blockNumber, new Set());
    blocks.get(requirement.blockNumber).add(requirement.transactionHash);
  }
  return [...blocks.entries()].sort(([left], [right]) => (
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
  ));
}

async function persistPositions(repository, positions) {
  let persisted = 0;
  for (let offset = 0; offset < positions.length; offset += POSITION_WRITE_BATCH_SIZE) {
    const result = await repository.upsertPositions(
      positions.slice(offset, offset + POSITION_WRITE_BATCH_SIZE)
    );
    persisted += Number(result.persisted || 0);
  }
  return persisted;
}

function createRobinhoodTransactionPositionResolver(options = {}) {
  const { rpcClient, repository } = options;
  if (typeof rpcClient?.requestBatch !== 'function') {
    throw new TypeError('transaction-position resolver requires archive RPC batch support');
  }
  if (typeof repository?.upsertPositions !== 'function') {
    throw new TypeError('transaction-position resolver requires a repository');
  }
  const blockBatchSize = boundedBatchSize(options.blockBatchSize);

  async function resolveSwaps(swaps = [], input = {}) {
    const requirements = swapRequirements(swaps);
    const blocks = unresolvedBlocks(requirements);
    const resolvedPositions = [];
    let rpcBatches = 0;
    for (let offset = 0; offset < blocks.length; offset += blockBatchSize) {
      const slice = blocks.slice(offset, offset + blockBatchSize);
      const responses = await rpcClient.requestBatch(slice.map(([blockNumber]) => ({
        method: 'eth_getBlockByNumber', params: [blockTag(blockNumber), true],
      })));
      rpcBatches += 1;
      if (!Array.isArray(responses) || responses.length !== slice.length) {
        throw new Error('transaction-position RPC batch returned an invalid result count');
      }
      for (let index = 0; index < slice.length; index += 1) {
        const [blockNumber, hashes] = slice[index];
        const indexed = indexBlockSenders(responses[index], { expectedBlockNumber: blockNumber });
        for (const transactionHash of hashes) {
          const position = indexed.positions.get(transactionHash);
          if (!position) throw new Error('swap transaction is absent from its canonical block');
          requirements.get(transactionHash).transactionIndex = position.transactionIndex;
          resolvedPositions.push(position);
        }
      }
    }
    const persisted = input.commit === true
      ? await persistPositions(repository, resolvedPositions) : 0;
    const enriched = swaps.map((swap) => {
      const hash = fixedHex(
        value(swap, 'transactionHash', 'transaction_hash'), 'swap transactionHash', 32
      );
      return Object.freeze({
        ...swap, transaction_index: requirements.get(hash).transactionIndex,
      });
    });
    return Object.freeze({
      swaps: Object.freeze(enriched),
      telemetry: Object.freeze({
        required: requirements.size, resolved: resolvedPositions.length,
        persisted, rpcBlocks: blocks.length, rpcBatches,
      }),
    });
  }

  return Object.freeze({ resolveSwaps });
}

module.exports = {
  createRobinhoodTransactionPositionResolver,
  __private: { swapRequirements, unresolvedBlocks },
};
