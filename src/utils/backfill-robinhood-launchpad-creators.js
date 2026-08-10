/** Historical creator attribution from proven launchpad events. Dry-run by default. */
const db = require('../models/db');
const config = require('../../config');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');
const {
  buildLaunchpadCreatorFilter, decodeLaunchpadCreatorLog,
} = require('../services/robinhood-launchpad-creator-adapter');

const CONFIRM = '--confirm-backfill-robinhood-launchpad-creators';

function quantity(value, label, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function integer(value, label, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be ${min}..${max}`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const read = (name, fallback) => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
  };
  const apply = argv.includes(CONFIRM);
  const rangeSize = integer(read('--range-size', 10_000), '--range-size', 10_000, 1, 100_000);
  const minRangeSize = integer(read('--min-range-size', 100), '--min-range-size', 100, 1, rangeSize);
  return {
    apply,
    fromBlock: quantity(read('--from-block', 0), '--from-block'),
    toBlock: quantity(read('--to-block', null), '--to-block', true),
    confirmations: integer(read('--confirmations', 2), '--confirmations', 2, 0, 1000),
    rangeSize,
    minRangeSize,
    maxRanges: integer(read('--max-ranges', apply ? 0 : 1), '--max-ranges', apply ? 0 : 1, 0, 1_000_000),
  };
}

const blockTag = (value) => `0x${BigInt(value).toString(16)}`;

async function fetchRange(client, fromBlock, requestedTo, minRangeSize) {
  let toBlock = requestedTo;
  let requests = 0;
  for (;;) {
    requests += 1;
    try {
      const logs = await client.request('eth_getLogs', [
        buildLaunchpadCreatorFilter(fromBlock, toBlock),
      ]);
      if (!Array.isArray(logs)) throw Object.assign(new Error('launchpad logs response is invalid'), { fatal: true });
      return { logs, toBlock, requests };
    } catch (error) {
      const width = toBlock - fromBlock + 1n;
      if (error.fatal || width <= BigInt(minRangeSize)) throw error;
      const nextWidth = width / 2n < BigInt(minRangeSize) ? BigInt(minRangeSize) : width / 2n;
      toBlock = fromBlock + nextWidth - 1n;
    }
  }
}

function decodeRange(logs, fromBlock, toBlock) {
  const deployments = logs.map(decodeLaunchpadCreatorLog);
  if (deployments.some((item) => (
    BigInt(item.blockNumber) < fromBlock || BigInt(item.blockNumber) > toBlock
  ))) throw new Error('launchpad log is outside the requested range');
  const tokens = new Set();
  for (const item of deployments) {
    if (tokens.has(item.tokenAddress)) throw new Error('duplicate launchpad token evidence in one range');
    tokens.add(item.tokenAddress);
  }
  return deployments;
}

function checkpoint(block, expectedBlock) {
  if (quantity(block?.number, 'checkpoint.number') !== expectedBlock
    || !/^0x[0-9a-f]{64}$/i.test(String(block?.hash || ''))) {
    throw new Error('launchpad backfill checkpoint is invalid');
  }
  const timestamp = new Date(Number(quantity(block.timestamp, 'checkpoint.timestamp')) * 1000);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('launchpad checkpoint timestamp is invalid');
  return { hash: String(block.hash).toLowerCase(), timestamp: timestamp.toISOString() };
}

async function revalidateCursor(client, cursor) {
  if (cursor?.checkpoint_block == null) return;
  const expected = BigInt(cursor.checkpoint_block);
  const current = checkpoint(
    await client.request('eth_getBlockByNumber', [blockTag(expected), false]), expected
  );
  if (current.hash !== String(cursor.checkpoint_hash).toLowerCase()) {
    throw new Error('launchpad backfill checkpoint diverged');
  }
}

async function run(deps = {}) {
  const options = deps.options || parseArgs();
  const repository = deps.repository || createRobinhoodTokenAttributionRepository();
  const client = deps.client || createRobinhoodRpcClient(config.robinhoodIngestionWorker);
  await (deps.validateChainIds || validateRobinhoodProviderChainIds)(client);
  const head = quantity(await client.request('eth_blockNumber'), 'head');
  const safeHead = head >= BigInt(options.confirmations) ? head - BigInt(options.confirmations) : 0n;
  const targetBlock = options.toBlock == null || options.toBlock > safeHead ? safeHead : options.toBlock;
  let cursor = await repository.loadLaunchpadBackfillCursor();
  if (!cursor && options.apply) {
    cursor = await repository.initializeLaunchpadBackfillCursor(
      options.fromBlock.toString(), targetBlock.toString()
    );
  }
  await revalidateCursor(client, cursor);
  let nextBlock = cursor ? BigInt(cursor.next_block) : options.fromBlock;
  const summary = {
    apply: options.apply, status: 'complete', head: head.toString(), safeHead: safeHead.toString(),
    targetBlock: targetBlock.toString(), nextBlock: nextBlock.toString(), ranges: 0,
    logRequests: 0, adaptiveSplits: 0, events: 0, attributed: 0,
  };
  while (nextBlock <= targetBlock && (!options.maxRanges || summary.ranges < options.maxRanges)) {
    const requestedTo = nextBlock + BigInt(options.rangeSize) - 1n > targetBlock
      ? targetBlock : nextBlock + BigInt(options.rangeSize) - 1n;
    const fetched = await fetchRange(client, nextBlock, requestedTo, options.minRangeSize);
    const deployments = decodeRange(fetched.logs, nextBlock, fetched.toBlock);
    summary.logRequests += fetched.requests;
    summary.adaptiveSplits += fetched.requests - 1;
    summary.events += deployments.length;
    if (options.apply) {
      const block = checkpoint(
        await client.request('eth_getBlockByNumber', [blockTag(fetched.toBlock), false]),
        fetched.toBlock
      );
      const result = await repository.recordLaunchpadBackfillRange({
        fromBlock: nextBlock.toString(), toBlock: fetched.toBlock.toString(),
        safeHead: safeHead.toString(), checkpointHash: block.hash,
        checkpointTimestamp: block.timestamp, deployments,
      });
      summary.attributed += result.attributed;
    }
    summary.ranges += 1;
    nextBlock = fetched.toBlock + 1n;
    summary.nextBlock = nextBlock.toString();
  }
  if (nextBlock <= targetBlock) summary.status = 'limited';
  return summary;
}

async function main() {
  try { console.log(JSON.stringify(await run(), null, 2)); }
  catch (error) { console.error('launchpad creator backfill failed:', error.message); process.exitCode = 1; }
  finally { await db.pool.end().catch(() => {}); }
}

if (require.main === module) void main();

module.exports = {
  CONFIRM, parseArgs, run,
  __private: { checkpoint, decodeRange, fetchRange, revalidateCursor },
};
