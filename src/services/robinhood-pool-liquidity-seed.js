const { parseQuantity, toQuantity } = require('./evm-log-poller');

function concurrency(value) {
  const parsed = Number(value ?? 8);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('seed concurrency must be between 1 and 20');
  }
  return parsed;
}

async function mapConcurrent(items, limit, operation) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await operation(items[index]);
    }
  }));
  return output;
}

function normalizeAnchor(block, expectedNumber) {
  const number = parseQuantity(block?.number, 'block.number').toString();
  const hash = String(block?.hash || '').toLowerCase();
  const timestamp = parseQuantity(block?.timestamp, 'block.timestamp');
  if (number !== expectedNumber || !/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`canonical block ${expectedNumber} is invalid`);
  }
  return Object.freeze({ hash, observedAt: new Date(Number(timestamp * 1000n)).toISOString() });
}

async function runRobinhoodPoolLiquiditySeed(deps = {}, options = {}) {
  if (!deps.repository || !deps.cursorRepository) throw new Error('seed repositories are required');
  const write = options.write === true;
  const cursor = await deps.cursorRepository.loadCursor();
  if (write && cursor) {
    const error = new Error('liquidity event cursor already exists');
    error.code = 'liquidity_seed_after_cursor';
    throw error;
  }
  const throughBlock = await deps.cursorRepository.resolveProcessingFrontier();
  if (throughBlock == null) throw new Error('processing frontier is unavailable');
  const candidates = await deps.repository.listCandidates({ throughBlock });
  const blockNumbers = [...new Set(candidates.map(({ blockNumber }) => blockNumber))];
  const summary = {
    mode: write ? 'write' : 'dry-run', throughBlock,
    startBlock: (BigInt(throughBlock) + 1n).toString(),
    candidates: candidates.length, distinctBlocks: blockNumbers.length,
  };
  if (!write) return Object.freeze({ ...summary, written: 0 });
  if (!deps.rpcClient?.request) throw new Error('rpcClient is required in write mode');
  const anchors = await mapConcurrent(blockNumbers, concurrency(options.concurrency), async (number) => {
    const block = await deps.rpcClient.request('eth_getBlockByNumber', [toQuantity(number), false]);
    return [number, normalizeAnchor(block, number)];
  });
  const byBlock = new Map(anchors);
  const rows = candidates.map((candidate) => ({
    protocol: candidate.protocol, market_key: candidate.marketKey,
    block_number: candidate.blockNumber, block_hash: byBlock.get(candidate.blockNumber).hash,
    observed_at: byBlock.get(candidate.blockNumber).observedAt,
    liquidity_usd: candidate.liquidityUsd, liquidity_raw: candidate.liquidityRaw,
    liquidity_status: candidate.liquidityStatus,
    liquidity_confidence: candidate.liquidityConfidence,
    liquidity_warning: candidate.liquidityWarning,
  }));
  const committed = await deps.repository.commitSeed({ rows, startBlock: summary.startBlock });
  return Object.freeze({
    ...summary, written: committed.written,
    skipped: rows.length - committed.written, cursorInitialized: true,
  });
}

module.exports = { runRobinhoodPoolLiquiditySeed };
