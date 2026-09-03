require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const v4 = require('../services/uniswap-v4-decoder');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { isAdaptiveRangeError } = require('../services/evm-log-poller');
const { createV4BlockedPreviewRepository } = require('../models/robinhood-v4-blocked-preview');

const identity = (event) => `${event.transactionHash}:${event.logIndex}`;
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function quantity(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Expected a nonnegative decimal block');
  return BigInt(value).toString();
}
function parseArgs(argv, env = process.env) {
  const args = {};
  for (const arg of argv) {
    const match = /^--(through-block|range-size|output-dir)=(.+)$/.exec(arg);
    if (!match || args[match[1]]) throw new Error(`Unsupported or repeated argument: ${arg}`);
    args[match[1]] = match[2];
  }
  const rangeSize = Number(args['range-size'] || 10000);
  if (!Number.isSafeInteger(rangeSize) || rangeSize < 1 || rangeSize > 10000) {
    throw new Error('range-size must be 1..10000');
  }
  if (!args['output-dir']) throw new Error('output-dir is required');
  const rpcUrl = env.ROBINHOOD_V4_REPLAY_RPC_URL;
  if (!rpcUrl || !/^https?:$/.test(new URL(rpcUrl).protocol)) throw new Error('Archive RPC URL is required');
  return { throughBlock: quantity(args['through-block']), rangeSize, rpcUrl,
    outputDir: path.resolve(args['output-dir']) };
}
async function save(filename, state) {
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}
async function header(rpc, number, expectedHash) {
  const block = await rpc.request('eth_getBlockByNumber', [hex(number), false]);
  if (!block || BigInt(block.number) !== BigInt(number) || !/^0x[0-9a-f]{64}$/.test(block.hash)
    || !/^(0x[0-9a-f]+|\d+)$/.test(String(block.timestamp))
    || (expectedHash && block.hash !== expectedHash)) throw new Error(`Canonical block mismatch: ${number}`);
  return block;
}
async function initialize(rpc, target) {
  if (target.origin_address !== v4.ROBINHOOD_V4_POOL_MANAGER
    || !/^0x[0-9a-f]{64}$/.test(target.pool_id)
    || BigInt(quantity(target.discovery_block)) > BigInt(target.blocked_block)) {
    throw new Error('Pool registry lacks a valid discovery boundary or manager');
  }
  const logs = await rpc.request('eth_getLogs', [{ address: target.origin_address,
    topics: [v4.TOPICS.initialize, target.pool_id], fromBlock: hex(target.discovery_block),
    toBlock: hex(target.discovery_block) }]);
  if (!Array.isArray(logs) || logs.length !== 1 || logs[0].removed
    || BigInt(logs[0].blockNumber) !== BigInt(target.discovery_block)) throw new Error('Initialize log is unavailable');
  await header(rpc, target.discovery_block, logs[0].blockHash);
  const pool = v4.decodeInitialize(logs[0]);
  if (pool.poolId !== target.pool_id || pool.tickSpacing !== Number(target.tick_spacing)) {
    throw new Error('Initialize conflicts with pool registry');
  }
}
async function fetchRange(rpc, target, start, size) {
  const end = BigInt(target.blocked_block);
  const to = start + BigInt(size) - 1n < end ? start + BigInt(size) - 1n : end;
  const logs = await rpc.request('eth_getLogs', [{ address: target.origin_address,
    topics: [v4.TOPICS.modifyLiquidity, target.pool_id], fromBlock: hex(start), toBlock: hex(to) }]);
  if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return logs');
  if (logs.length >= 10000) throw Object.assign(new Error('Possibly truncated logs'), { code: 'log_range_error' });
  const headers = new Map();
  const events = new Map();
  for (const log of logs) {
    const block = BigInt(log.blockNumber);
    if (log.removed || block < start || block > to) throw new Error('Removed or out-of-range archive log');
    if (!headers.has(String(block))) headers.set(String(block), await header(rpc, block, log.blockHash));
    const canonical = headers.get(String(block));
    if (canonical.hash !== log.blockHash) throw new Error('Archive log hash mismatch');
    const event = v4.decodeModifyLiquidity({ ...log, blockTimestamp: canonical.timestamp }, {
      tracked: true, poolId: target.pool_id, marketKey: target.market_key,
      tickSpacing: Number(target.tick_spacing), poolManagerAddress: target.origin_address,
    });
    if (block === end && BigInt(event.logIndex) > BigInt(target.log_index)) continue;
    if (events.has(identity(event)) && digest(events.get(identity(event))) !== digest(event)) {
      throw new Error('Conflicting archive duplicate');
    }
    events.set(identity(event), event);
  }
  return { nextBlock: String(to + 1n), events: [...events.values()].sort((a, b) => (
    BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1
      : Number(BigInt(a.logIndex) - BigInt(b.logIndex))
  )) };
}
function matchesLedger(event, row) {
  return [['blockNumber', 'block_number'], ['blockHash', 'block_hash'], ['poolId', 'pool_id'],
    ['marketKey', 'market_key'], ['sender', 'sender'], ['tickLower', 'tick_lower'],
    ['tickUpper', 'tick_upper'], ['liquidityDelta', 'liquidity_delta'], ['salt', 'salt']]
    .every(([key, column]) => String(event[key]) === String(row[column]))
    && new Date(row.observed_at).getTime() === Number(event.timestampMs);
}
async function compare(repository, item) {
  const counts = { archiveEvents: item.events.length, missingPredecessors: 0, conflicts: 0,
    processedWithoutDelta: 0, negativePrefixes: 0 };
  const balances = new Map();
  const details = [];
  for (let offset = 0; offset < item.events.length; offset += 500) {
    const events = item.events.slice(offset, offset + 500);
    const found = await repository.identities(events);
    for (const event of events) {
      const state = found.get(identity(event));
      if (!state) throw new Error('Database comparison omitted an identity');
      const blocker = identity(event) === `${item.target.transaction_hash}:${item.target.log_index}`;
      if (blocker && event.blockNumber !== item.target.blocked_block) throw new Error('Blocker identity moved');
      const status = !state.ledger ? 'missing' : matchesLedger(event, state.ledger) ? 'matched' : 'conflict';
      if (!blocker && status === 'missing') counts.missingPredecessors += 1;
      if (status === 'conflict') counts.conflicts += 1;
      if (state.processed && !state.ledger) counts.processedWithoutDelta += 1;
      const key = `${event.tickLower}:${event.tickUpper}`;
      const balance = (balances.get(key) || 0n) + BigInt(event.liquidityDelta);
      balances.set(key, balance);
      if (balance < 0n) counts.negativePrefixes += 1;
      details.push({ identity: identity(event), blocker, status,
        captureStatus: state.capture_status, processed: state.processed });
    }
  }
  if (!details.some((row) => row.blocker)) throw new Error('Blocked event is absent from archive');
  return { marketKey: item.target.market_key, ...counts, comparedAt: new Date().toISOString(), details,
    archiveBalancesThroughBlocker: Object.fromEntries([...balances].map(([key, value]) => [key, String(value)])),
    currentMaterializedRanges: await repository.ranges(item.target.pool_id) };
}
async function loadState(filename, options, repository) {
  let state;
  let resumed = false;
  try { state = JSON.parse(await fs.readFile(filename, 'utf8')); resumed = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state) {
    const targets = await repository.targets(options.throughBlock);
    if (targets.length > 7) throw new Error('More than 7 pools: narrow through-block');
    state = { version: 1, mode: 'read-only', throughBlock: options.throughBlock,
      pools: targets.map((target) => ({ target, nextBlock: target.discovery_block, events: [] })) };
  }
  const { checksum, ...payload } = state;
  if ((resumed && checksum !== digest(payload)) || state.version !== 1 || state.mode !== 'read-only'
    || state.throughBlock !== options.throughBlock || state.pools.length > 7) throw new Error('Checkpoint mismatch');
  return payload;
}
async function scanPool(item, options, { rpc, progress, shouldStop }, persist) {
  let size = options.rangeSize;
  while (BigInt(item.nextBlock) <= BigInt(item.target.blocked_block)) {
    if (shouldStop()) throw new Error('Interrupted; resume with the same output-dir');
    let range;
    try { range = await fetchRange(rpc, item.target, BigInt(item.nextBlock), size); }
    catch (error) {
      if (size === 1 || (!isAdaptiveRangeError(error) && error.rpcCode !== -32000)) throw error;
      size = Math.max(1, Math.floor(size / 2));
      continue;
    }
    if (item.events.length + range.events.length > 100000) throw new Error('Pool exceeds 100000 events');
    await header(rpc, item.target.blocked_block, item.target.block_hash);
    item.events.push(...range.events);
    item.nextBlock = range.nextBlock;
    await persist();
    progress(JSON.stringify({ event: 'v4_blocked_preview_progress', pool: item.target.pool_id,
      nextBlock: item.nextBlock, throughBlock: item.target.blocked_block, events: item.events.length }));
  }
}
async function runPreview(options, { rpc, repository, progress = console.log, shouldStop = () => false }) {
  if (BigInt(await rpc.request('eth_chainId')) !== 4663n) throw new Error('Wrong archive chain');
  await fs.mkdir(options.outputDir, { recursive: true });
  const lockPath = path.join(options.outputDir, 'preview.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(String(process.pid));
    const filename = path.join(options.outputDir, 'checkpoint.json');
    const state = await loadState(filename, options, repository);
    for (const item of state.pools) {
      await header(rpc, item.target.blocked_block, item.target.block_hash);
      await initialize(rpc, item.target);
      if (BigInt(quantity(item.nextBlock)) < BigInt(item.target.discovery_block)
        || BigInt(item.nextBlock) > BigInt(item.target.blocked_block) + 1n) throw new Error('Invalid checkpoint cursor');
    }
    const persist = () => save(filename, { ...state, checksum: digest(state) });
    await persist();
    for (const item of state.pools) {
      await scanPool(item, options, { rpc, progress, shouldStop }, persist);
    }
    const report = { mode: 'read-only', throughBlock: state.throughBlock,
      checkpointChecksum: digest(state), completed: true, pools: [] };
    for (const item of state.pools) {
      report.pools.push(await compare(repository, item));
      await header(rpc, item.target.blocked_block, item.target.block_hash);
    }
    await save(path.join(options.outputDir, 'report.json'), report);
    progress(JSON.stringify({ event: 'v4_blocked_preview_complete', outputDir: options.outputDir,
      pools: report.pools.map(({ details: _details, currentMaterializedRanges: _ranges,
        archiveBalancesThroughBlocker: _balances, ...summary }) => summary) }));
    return report;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  const client = await db.getClient();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await client.query("SET default_transaction_read_only = on; SET statement_timeout = '30s'; SET lock_timeout = '2s'");
    const rpc = createEvmJsonRpcClient({ providers: [{ name: 'v4-preview', url: options.rpcUrl }],
      timeoutMs: 60000, maxRetries: 1 });
    await runPreview(options, { rpc, repository: createV4BlockedPreviewRepository(client), shouldStop: () => stopping });
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    client.release(); await db.pool.end();
  }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { runPreview, parseArgs, matchesLedger, fetchRange };
