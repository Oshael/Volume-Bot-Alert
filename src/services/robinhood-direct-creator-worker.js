const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const {
  createRobinhoodCanonicalDirectCreatorSource,
} = require('../models/robinhood-canonical-direct-creator-source');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');
const {
  FACTORIES, decodeLaunchpadCreatorLog,
} = require('./robinhood-launchpad-creator-adapter');

const RPC_SOURCE = 'rpc';
const CANONICAL_SOURCE = 'canonical_journal';

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function hex(value, bytes, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function bounded(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`value must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function blockTag(value) { return `0x${BigInt(value).toString(16)}`; }

function sourceContractError(message) {
  return Object.assign(new Error(message), { code: 'source_contract_error', fatal: true });
}

function normalizeSource(value) {
  const normalized = String(value || RPC_SOURCE).trim().toLowerCase();
  if (![RPC_SOURCE, CANONICAL_SOURCE].includes(normalized)) {
    throw Object.assign(new Error(
      `ROBINHOOD_DIRECT_CREATOR_LIVE_SOURCE must be ${RPC_SOURCE} or ${CANONICAL_SOURCE}`
    ), { code: 'configuration_error', fatal: true });
  }
  return normalized;
}

function indexBlockReceipts(receipts, transactions, expectedBlock, blockHash) {
  if (!Array.isArray(receipts) || receipts.length !== transactions.length) {
    throw sourceContractError(`direct creator block ${expectedBlock} receipts are incomplete`);
  }
  const expectedHashes = new Set(transactions.map((tx) => hex(tx.hash, 32, 'transaction.hash')));
  const byHash = new Map();
  for (const receipt of receipts) {
    const transactionHash = hex(receipt?.transactionHash, 32, 'receipt.transactionHash');
    if (byHash.has(transactionHash) || !expectedHashes.has(transactionHash)
      || quantity(receipt?.blockNumber, 'receipt.blockNumber') !== expectedBlock
      || hex(receipt?.blockHash, 32, 'receipt.blockHash') !== blockHash
      || !Array.isArray(receipt?.logs)) {
      throw sourceContractError('direct creator receipt diverged from its block');
    }
    byHash.set(transactionHash, receipt);
  }
  return byHash;
}

function isLaunchpadCreatorLog(log) {
  const spec = FACTORIES.get(String(log?.address || '').toLowerCase());
  return Boolean(spec && String(log?.topics?.[0] || '').toLowerCase() === spec.topic);
}

async function scanBlock(client, expectedBlock) {
  const [block, receipts] = await Promise.all([
    client.request('eth_getBlockByNumber', [blockTag(expectedBlock), true]),
    client.request('eth_getBlockReceipts', [blockTag(expectedBlock)]),
  ]);
  const number = quantity(block?.number, 'block.number');
  if (number !== expectedBlock || !Array.isArray(block?.transactions)) {
    throw sourceContractError(`direct creator block ${expectedBlock} is incomplete`);
  }
  const blockHash = hex(block.hash, 32, 'block.hash');
  const blockTimestamp = new Date(Number(quantity(block.timestamp, 'block.timestamp')) * 1000);
  if (block.transactions.some((tx) => !tx || typeof tx !== 'object'
    || !Object.prototype.hasOwnProperty.call(tx, 'to'))) {
    throw sourceContractError('direct creator RPC did not return full transactions');
  }
  const receiptsByHash = indexBlockReceipts(
    receipts, block.transactions, expectedBlock, blockHash
  );
  const direct = block.transactions.filter((tx) => tx && tx.to === null);
  for (const tx of direct) {
    hex(tx.hash, 32, 'transaction.hash');
    hex(tx.from, 20, 'transaction.from');
  }
  const directDeployments = direct.flatMap((tx) => {
    const receipt = receiptsByHash.get(tx.hash.toLowerCase());
    if (receipt.contractAddress == null) return [];
    return [{
      tokenAddress: hex(receipt.contractAddress, 20, 'receipt.contractAddress'),
      creatorAddress: tx.from.toLowerCase(),
      transactionHash: tx.hash.toLowerCase(),
      factoryAddress: null,
      source: 'rpc_direct',
    }];
  });
  let launchpadDeployments;
  try {
    launchpadDeployments = receipts.flatMap((receipt) => (
      receipt.logs.filter(isLaunchpadCreatorLog).map(decodeLaunchpadCreatorLog)
    ));
    if (launchpadDeployments.some((item) => (
      BigInt(item.blockNumber) !== expectedBlock || item.blockHash !== blockHash
    ))) throw new Error('launchpad event diverged from its block');
  } catch (cause) {
    throw Object.assign(new Error(`launchpad creator evidence is invalid: ${cause.message}`), {
      code: 'source_contract_error', fatal: true, cause,
    });
  }
  return {
    blockNumber: number.toString(), blockHash,
    blockTimestamp: blockTimestamp.toISOString(),
    deployments: [...directDeployments, ...launchpadDeployments],
  };
}

async function revalidateCheckpoint(client, cursor) {
  if (cursor?.checkpoint_block == null) return;
  const block = await client.request(
    'eth_getBlockByNumber', [blockTag(cursor.checkpoint_block), false]
  );
  if (
    quantity(block?.number, 'checkpoint.number').toString() !== String(cursor.checkpoint_block)
    || hex(block?.hash, 32, 'checkpoint.hash') !== String(cursor.checkpoint_hash).toLowerCase()
  ) throw Object.assign(new Error('direct creator LIVE checkpoint diverged'), {
    code: 'persistent_reorg', fatal: true,
  });
}

function createRpcSource(client) {
  return Object.freeze({
    batchRead: false,
    async getSafeHead(confirmations) {
      const head = quantity(await client.request('eth_blockNumber'), 'head');
      const safeHead = head >= BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
      return { head: head.toString(), safeHead: safeHead.toString() };
    },
    async matchesCheckpoint(checkpoint) {
      try {
        await revalidateCheckpoint(client, {
          checkpoint_block: checkpoint.number, checkpoint_hash: checkpoint.hash,
        });
        return true;
      } catch (error) {
        if (error.code === 'persistent_reorg') return false;
        throw error;
      }
    },
    async readRange(fromBlock, toBlock) {
      const blocks = new Map();
      for (let number = BigInt(fromBlock); number <= BigInt(toBlock); number += 1n) {
        blocks.set(number.toString(), await scanBlock(client, number));
      }
      return blocks;
    },
  });
}

async function runDirectCreatorTick(deps = {}) {
  const confirmations = bounded(deps.confirmations, 2, 0, 1000);
  const maxBlocks = bounded(deps.maxBlocks, 100, 1, 2000);
  const source = deps.source || createRpcSource(deps.client);
  const frontier = await source.getSafeHead(confirmations);
  const head = quantity(frontier.head, 'head');
  const safeHead = quantity(frontier.safeHead, 'safeHead');
  let cursor = await deps.repository.loadDirectCursor();
  if (!cursor) cursor = await deps.repository.initializeDirectCursor(safeHead.toString());
  if (cursor.checkpoint_block != null && !await source.matchesCheckpoint({
    number: cursor.checkpoint_block, hash: cursor.checkpoint_hash,
  })) throw Object.assign(new Error('direct creator LIVE checkpoint diverged'), {
    code: 'persistent_reorg', fatal: true,
  });
  if (quantity(cursor.safe_head, 'cursor.safeHead') > safeHead) {
    throw Object.assign(new Error('direct creator safe frontier regressed'), {
      code: 'persistent_reorg', fatal: true,
    });
  }
  let nextBlock = quantity(cursor.next_block, 'cursor.nextBlock');
  let processedBlocks = 0;
  let attributed = 0;
  while (nextBlock <= safeHead && processedBlocks < maxBlocks) {
    const remaining = BigInt(maxBlocks - processedBlocks);
    const pageSize = source.batchRead === false ? 1n : remaining;
    const throughBlock = nextBlock + pageSize - 1n < safeHead
      ? nextBlock + pageSize - 1n : safeHead;
    const blocks = await source.readRange(nextBlock, throughBlock);
    while (nextBlock <= throughBlock) {
      const scanned = blocks.get(nextBlock.toString());
      if (!scanned) throw sourceContractError(`direct creator block ${nextBlock} is missing`);
      const result = await deps.repository.recordCreatorBlock({
        ...scanned, safeHead: safeHead.toString(),
      });
      attributed += result.attributed;
      processedBlocks += 1;
      nextBlock += 1n;
    }
  }
  return {
    status: nextBlock > safeHead ? 'caught-up' : 'catching-up',
    head: head.toString(), safeHead: safeHead.toString(), nextBlock: nextBlock.toString(),
    processedBlocks, attributed, lagBlocks: nextBlock > safeHead ? 0 : Number(safeHead - nextBlock + 1n),
  };
}

function createRobinhoodDirectCreatorWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let timer = null;
  let runtime = null;
  let inFlight = null;
  let options = {};
  let running = false;
  const status = {
    enabled: false, running: false, sourceMode: null, lastResult: null, lastError: null,
  };

  async function buildRuntime() {
    let source;
    if (options.sourceMode === CANONICAL_SOURCE) {
      source = deps.canonicalSource
        || (deps.canonicalSourceFactory || createRobinhoodCanonicalDirectCreatorSource)();
      await source.assertChain();
    } else {
      const client = (deps.clientFactory || createRobinhoodRpcClient)(options.rpcOptions || {});
      await (deps.validateChainIds || validateRobinhoodProviderChainIds)(client);
      source = createRpcSource(client);
    }
    return {
      source, sourceMode: options.sourceMode,
      repository: (deps.repositoryFactory || createRobinhoodTokenAttributionRepository)(),
    };
  }
  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        runtime ||= await buildRuntime();
        status.sourceMode = runtime.sourceMode;
        status.lastResult = await runDirectCreatorTick({ ...runtime, ...options });
        status.lastError = null;
        return status.lastResult;
      } catch (error) {
        status.lastError = { code: error.code || 'direct_creator_error', message: error.message };
        if (error.fatal) {
          running = false;
          status.running = false;
          await options.onFatal?.(error);
        } else logger.warn('[RobinhoodDirectCreatorWorker] Tick failed:', error.message);
        return null;
      } finally { inFlight = null; }
    })();
    return inFlight;
  }
  function queue(delay) {
    if (!running) return;
    timer = schedule(async () => { await runOnce(); queue(options.intervalMs); }, delay);
    timer?.unref?.();
  }
  function start(input = {}) {
    if (running || input.enabled !== true) return false;
    options = {
      ...input,
      sourceMode: normalizeSource(input.sourceMode ?? process.env.ROBINHOOD_DIRECT_CREATOR_LIVE_SOURCE),
      intervalMs: bounded(input.intervalMs, 2000, 250, 300_000),
      maxBlocks: bounded(input.maxBlocks, 100, 1, 2000),
      confirmations: bounded(input.confirmations, 2, 0, 1000),
    };
    status.enabled = true;
    status.running = true;
    running = true;
    queue(0);
    return true;
  }
  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancel(timer);
    timer = null;
    if (inFlight) await inFlight;
  }
  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodDirectCreatorWorker();
module.exports = {
  CANONICAL_SOURCE, RPC_SOURCE,
  createRobinhoodDirectCreatorWorker, runDirectCreatorTick,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { createRpcSource, normalizeSource, scanBlock },
};
