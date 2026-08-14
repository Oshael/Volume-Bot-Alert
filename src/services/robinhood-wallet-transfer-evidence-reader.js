const MAX_BLOCK_BATCH_SIZE = 100;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000n;

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function blockTag(value) {
  return `0x${quantity(value, 'blockNumber').toString(16)}`;
}

function blockTime(value) {
  const milliseconds = quantity(value, 'block.timestamp') * 1000n;
  if (milliseconds > MAX_DATE_MILLISECONDS) throw new Error('block.timestamp exceeds JavaScript Date');
  return new Date(Number(milliseconds)).toISOString();
}

function normalizeBlockEvidence(block, expectedNumber) {
  const number = quantity(block?.number, 'block.number');
  if (number !== expectedNumber) throw new Error('RPC block does not match requested number');
  return Object.freeze({
    number: number.toString(),
    hash: fixedHex(block?.hash, 'block.hash', 32),
    blockTime: blockTime(block?.timestamp),
  });
}

function sortedBlockNumbers(captured) {
  if (!Array.isArray(captured?.transfers)) throw new Error('captured transfers must be a list');
  const values = new Set(captured.transfers.map((transfer) => (
    quantity(transfer.blockNumber, 'transfer.blockNumber').toString()
  )));
  values.add(quantity(captured.toBlock, 'captured.toBlock').toString());
  return [...values].sort((left, right) => (
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
  ));
}

async function loadBlockEvidence(rpcClient, blockNumbers, batchSize) {
  const evidence = new Map();
  let batches = 0;
  for (let offset = 0; offset < blockNumbers.length; offset += batchSize) {
    const slice = blockNumbers.slice(offset, offset + batchSize);
    const blocks = await rpcClient.requestBatch(slice.map((number) => ({
      method: 'eth_getBlockByNumber', params: [blockTag(number), false],
    })));
    batches += 1;
    if (!Array.isArray(blocks) || blocks.length !== slice.length) {
      throw new Error('block evidence batch returned an invalid result count');
    }
    for (let index = 0; index < slice.length; index += 1) {
      evidence.set(slice[index], normalizeBlockEvidence(blocks[index], BigInt(slice[index])));
    }
  }
  return { evidence, batches };
}

function enrichTransfers(transfers, evidence) {
  return transfers.map((transfer) => {
    const blockNumber = quantity(transfer.blockNumber, 'transfer.blockNumber').toString();
    const block = evidence.get(blockNumber);
    if (!block) throw new Error('transfer block evidence is missing');
    if (fixedHex(transfer.blockHash, 'transfer.blockHash', 32) !== block.hash) {
      throw new Error('transfer block hash conflicts with RPC evidence');
    }
    return Object.freeze({ ...transfer, blockNumber, blockTime: block.blockTime });
  });
}

function createRobinhoodWalletTransferEvidenceReader(options = {}) {
  const transferReader = options.transferReader;
  const rpcClient = options.rpcClient;
  if (typeof transferReader?.readGlobalRange !== 'function') {
    throw new TypeError('holder global Transfer reader is required');
  }
  if (typeof transferReader?.matchesCheckpoint !== 'function') {
    throw new TypeError('holder checkpoint reader is required');
  }
  if (typeof rpcClient?.requestBatch !== 'function') {
    throw new TypeError('block evidence RPC batch support is required');
  }
  const blockBatchSize = boundedInteger(
    options.blockBatchSize, 50, 1, MAX_BLOCK_BATCH_SIZE, 'blockBatchSize'
  );

  async function readRange(input = {}) {
    const captured = await transferReader.readGlobalRange(input);
    const blockNumbers = sortedBlockNumbers(captured);
    const loaded = await loadBlockEvidence(rpcClient, blockNumbers, blockBatchSize);
    const checkpointNumber = quantity(captured.checkpoint?.number, 'checkpoint.number').toString();
    const toBlock = quantity(captured.toBlock, 'captured.toBlock').toString();
    if (checkpointNumber !== toBlock) throw new Error('captured checkpoint does not end the range');
    const checkpoint = loaded.evidence.get(checkpointNumber);
    const checkpointHash = fixedHex(captured.checkpoint?.hash, 'checkpoint.hash', 32);
    if (checkpoint.hash !== checkpointHash) {
      throw new Error('captured checkpoint hash conflicts with RPC evidence');
    }
    const transfers = enrichTransfers(captured.transfers, loaded.evidence);
    return Object.freeze({
      ...captured,
      checkpoint: Object.freeze({
        number: checkpointNumber, hash: checkpointHash, blockTime: checkpoint.blockTime,
      }),
      transfers: Object.freeze(transfers),
      telemetry: Object.freeze({
        ...(captured.telemetry || {}), evidenceBatches: loaded.batches,
        evidenceBlocks: blockNumbers.length,
      }),
    });
  }

  function matchesCheckpoint(checkpoint) {
    return transferReader.matchesCheckpoint(checkpoint);
  }

  return Object.freeze({ matchesCheckpoint, readRange });
}

module.exports = {
  MAX_BLOCK_BATCH_SIZE,
  createRobinhoodWalletTransferEvidenceReader,
  __private: { blockTime, normalizeBlockEvidence },
};
