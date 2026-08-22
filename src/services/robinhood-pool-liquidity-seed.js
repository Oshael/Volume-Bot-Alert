const { parseQuantity, toQuantity } = require('./evm-log-poller');

function concurrency(value) {
  const parsed = Number(value ?? 8);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('seed concurrency must be between 1 and 20');
  }
  return parsed;
}

function headerBatchSize(value) {
  const parsed = Number(value ?? 100);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('seed header batch size must be between 1 and 100');
  }
  return parsed;
}

function chunks(items, size) {
  const output = [];
  for (let offset = 0; offset < items.length; offset += size) {
    output.push(items.slice(offset, offset + size));
  }
  return output;
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

function createProgressEmitter(options = {}) {
  const now = options.now || Date.now;
  return (phase, startedAt, state = {}) => {
    if (!options.onProgress) return;
    const processed = Number(state.processed || 0);
    const total = Number(state.total || 0);
    const elapsedMs = Math.max(0, now() - startedAt);
    const etaMs = processed > 0 && processed < total
      ? Math.round((elapsedMs / processed) * (total - processed))
      : (processed >= total ? 0 : null);
    options.onProgress(Object.freeze({ phase, processed, total, elapsedMs, etaMs, ...state }));
  };
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
  const emitProgress = createProgressEmitter(options);
  const scanStartedAt = (options.now || Date.now)();
  emitProgress('count', scanStartedAt, { processed: 0, total: 0 });
  const candidates = await deps.repository.listCandidates({
    throughBlock,
    onProgress: (state) => emitProgress('scan', scanStartedAt, state),
  });
  const blockNumbers = [...new Set(candidates.map(({ blockNumber }) => blockNumber))];
  const summary = {
    mode: write ? 'write' : 'dry-run', throughBlock,
    startBlock: (BigInt(throughBlock) + 1n).toString(),
    candidates: candidates.length, distinctBlocks: blockNumbers.length,
  };
  if (!write) return Object.freeze({ ...summary, written: 0 });
  if (!deps.rpcClient?.requestBatch) throw new Error('rpcClient batch support is required in write mode');
  const headersStartedAt = (options.now || Date.now)();
  let processedHeaders = 0;
  emitProgress('headers', headersStartedAt, { processed: 0, total: blockNumbers.length });
  const batches = chunks(blockNumbers, headerBatchSize(options.headerBatchSize));
  const anchorBatches = await mapConcurrent(
    batches, concurrency(options.concurrency), async (numbers) => {
      const blocks = await deps.rpcClient.requestBatch(numbers.map((number) => ({
        method: 'eth_getBlockByNumber', params: [toQuantity(number), false],
      })));
      if (!Array.isArray(blocks) || blocks.length !== numbers.length) {
        throw new Error('canonical block batch returned an invalid result count');
      }
      const normalized = blocks.map((block, index) => [
        numbers[index], normalizeAnchor(block, numbers[index]),
      ]);
      processedHeaders += numbers.length;
      emitProgress('headers', headersStartedAt, {
        processed: processedHeaders, total: blockNumbers.length,
      });
      return normalized;
    }
  );
  const anchors = anchorBatches.flat();
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
  const commitStartedAt = (options.now || Date.now)();
  emitProgress('commit', commitStartedAt, { processed: 0, total: rows.length, written: 0 });
  const committed = await deps.repository.commitSeed({
    rows, startBlock: summary.startBlock,
    onProgress: (state) => emitProgress('commit', commitStartedAt, state),
  });
  return Object.freeze({
    ...summary, written: committed.written,
    skipped: rows.length - committed.written, cursorInitialized: true,
  });
}

module.exports = { runRobinhoodPoolLiquiditySeed };
