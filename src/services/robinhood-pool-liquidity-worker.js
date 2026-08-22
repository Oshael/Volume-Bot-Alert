const { createEvmLogPoller, parseQuantity, toQuantity } = require('./evm-log-poller');
const {
  LIQUIDITY_EVENT_TOPICS,
  processLiquidityEventRange,
  repairLiquiditySnapshotsAfterReorg,
} = require('./robinhood-pool-liquidity-events');

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function cursorCheckpoint(cursor) {
  return cursor?.checkpoint ? { ...cursor.checkpoint } : null;
}

async function createRobinhoodPoolLiquidityWorker(deps = {}, input = {}) {
  if (!deps.rpcClient?.request || !deps.reader || !deps.snapshotRepository
    || !deps.cursorRepository) throw new Error('liquidity worker dependencies are required');
  const options = {
    startBlock: input.startBlock == null ? null : parseQuantity(input.startBlock).toString(),
    confirmations: integer(input.confirmations, 2, 0, 1000),
    rangeSize: integer(input.rangeSize, 10, 1, 10_000),
    minRangeSize: integer(input.minRangeSize, 1, 1, 1000),
    maxRangeSize: integer(input.maxRangeSize, 100, 1, 10_000),
    maxRangesPerPoll: integer(input.maxRangesPerPoll, 20, 1, 1000),
    reorgDepth: integer(input.reorgDepth, 12, 1, 1000),
    concurrency: integer(input.concurrency, 5, 1, 20),
  };
  let cursor = await deps.cursorRepository.loadCursor();
  if (!cursor) {
    if (options.startBlock == null) {
      const error = new Error('ROBINHOOD_POOL_LIQUIDITY_START_BLOCK is required for bootstrap');
      error.code = 'bootstrap_start_required';
      throw error;
    }
    cursor = await deps.cursorRepository.initializeCursor({ startBlock: options.startBlock });
  }
  const valuation = { affected: 0, saved: 0, failed: 0, lastResult: null };
  const frontierClient = {
    request: async (method, params, requestOptions) => {
      if (method !== 'eth_blockNumber') {
        return deps.rpcClient.request(method, params, requestOptions);
      }
      const [headValue, frontierValue] = await Promise.all([
        deps.rpcClient.request(method, params, requestOptions),
        deps.cursorRepository.resolveProcessingFrontier(),
      ]);
      if (frontierValue == null) throw new Error('processing frontier is unavailable');
      const head = parseQuantity(headValue, 'eth_blockNumber');
      const confirmations = BigInt(options.confirmations);
      const safeHead = head >= confirmations ? head - confirmations : 0n;
      const frontier = parseQuantity(frontierValue, 'processing frontier');
      return toQuantity((safeHead < frontier ? safeHead : frontier) + confirmations);
    },
  };
  const poller = (deps.pollerFactory || createEvmLogPoller)({
    client: frontierClient,
    startBlock: cursor.nextBlock,
    checkpoint: cursorCheckpoint(cursor),
    confirmations: options.confirmations,
    rangeSize: options.rangeSize,
    minRangeSize: options.minRangeSize,
    maxRangeSize: options.maxRangeSize,
    maxRangesPerPoll: options.maxRangesPerPoll,
    reorgDepth: options.reorgDepth,
    pollIntervalMs: input.pollIntervalMs,
    maxPollIntervalMs: input.maxPollIntervalMs,
    filter: { topics: [LIQUIDITY_EVENT_TOPICS] },
    onLogs: async (logs, context) => processLiquidityEventRange({
      reader: deps.reader, repository: deps.snapshotRepository,
    }, { logs, toBlock: context.toBlock }, {
      concurrency: options.concurrency, now: deps.now,
    }),
    onRange: async (range) => {
      cursor = await deps.cursorRepository.commitRange({
        fromBlock: range.fromBlock, nextBlock: range.nextBlock,
        safeHead: range.safeHead, checkpoint: range.checkpoint,
      });
      if (range.consumerResult) {
        valuation.lastResult = range.consumerResult;
        for (const key of ['affected', 'saved', 'failed']) valuation[key] += range.consumerResult[key];
      }
    },
    onReorg: async ({ rewindBlock }) => {
      if (BigInt(rewindBlock) < BigInt(cursor.coverageStartBlock)) {
        const error = new Error('liquidity reorg crossed the declared coverage start');
        error.code = 'persistent_reorg';
        throw error;
      }
      await repairLiquiditySnapshotsAfterReorg({
        reader: deps.reader, repository: deps.snapshotRepository,
      }, { rewindBlock }, { concurrency: options.concurrency, now: deps.now });
      cursor = await deps.cursorRepository.rewindCursor({ rewindBlock });
    },
    onRemoved: async (_logs, context) => {
      if (context.reason !== 'rpc_removed_flag') return;
      const error = new Error('removed liquidity log requires a canonical rewind');
      error.code = 'persistent_reorg';
      throw error;
    },
    onError: deps.onError || ((error) => console.warn(
      '[RobinhoodPoolLiquidityWorker] Poll failed:', error.message
    )),
  });

  async function stop() {
    poller.stop();
    while (poller.getStatus().polling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return Object.freeze({
    getStatus: () => ({ mode: 'event-driven', cursor, valuation: { ...valuation }, ...poller.getStatus() }),
    pollOnce: poller.pollOnce,
    start: poller.start,
    stop,
  });
}

module.exports = { createRobinhoodPoolLiquidityWorker };
