require('dotenv').config();

const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const db = require('../models/db');
const noxa = require('../services/noxa-launch-decoder');
const v2 = require('../services/uniswap-v2-decoder');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');

const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const EXPECTED_CHAIN_ID = 4663n;
const DEFAULT_RANGE_SIZES = Object.freeze([100, 250, 500, 1000, 5000]);
const MAX_SAMPLES = 3;
const WETH_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const TOTAL_SUPPLY_SELECTOR = '0x18160ddd';
const DISCOVERY_FILTER = Object.freeze({
  address: Object.freeze([
    v2.ROBINHOOD_V2_FACTORY,
    v3.ROBINHOOD_V3_FACTORY,
    v4.ROBINHOOD_V4_POOL_MANAGER,
    noxa.NOXA_FACTORY,
  ]),
  topics: Object.freeze([Object.freeze([
    v2.TOPICS.pairCreated,
    v3.TOPICS.poolCreated,
    v4.TOPICS.initialize,
    noxa.TOKEN_LAUNCHED_TOPIC,
  ])]),
});
const MARKET_FILTER = Object.freeze({
  topics: Object.freeze([Object.freeze([
    v2.TOPICS.swap,
    v2.TOPICS.sync,
    v3.TOPICS.initialize,
    v3.TOPICS.swap,
    v4.TOPICS.swap,
  ])]),
});

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function nonNegativeInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function parseRangeSizes(value, fallback = DEFAULT_RANGE_SIZES) {
  const source = String(value ?? '').trim();
  if (!source) return [...fallback];
  const ranges = [...new Set(source.split(',').map((entry) => {
    const parsed = Number.parseInt(entry.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : null;
  }).filter(Boolean))];
  if (!ranges.length) throw new Error('ROBINHOOD_PUBLIC_PROBE_RANGE_SIZES has no valid ranges');
  return ranges;
}

function parseQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a decimal or hex quantity`);
  }
  return BigInt(raw);
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function compactError(error) {
  return {
    code: error?.code || error?.name || 'error',
    message: String(error?.message || error).slice(0, 300),
    httpStatus: error?.httpStatus ?? null,
    rpcCode: error?.rpcCode ?? null,
  };
}

async function measure(operation) {
  const startedAt = Date.now();
  try {
    const value = await operation();
    return { ok: true, elapsedMs: Date.now() - startedAt, value };
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - startedAt, error: compactError(error) };
  }
}

function createPublicClient(options = {}) {
  return createEvmJsonRpcClient({
    providers: [{
      name: 'robinhood-public',
      url: options.rpcUrl || PUBLIC_RPC_URL,
    }],
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
    minRequestIntervalMs: 0,
  });
}

function streamDefinition(name, cursor) {
  return {
    name,
    cursor: parseQuantity(cursor?.next_block ?? cursor?.nextBlock, `${name}.nextBlock`),
    filter: name === 'discovery' ? DISCOVERY_FILTER : MARKET_FILTER,
  };
}

function rangeBounds(cursor, rangeSize, sample, safeHead) {
  const fromBlock = cursor + (BigInt(rangeSize) * BigInt(sample));
  if (fromBlock > safeHead) return null;
  const requestedTo = fromBlock + BigInt(rangeSize) - 1n;
  return { fromBlock, toBlock: requestedTo < safeHead ? requestedTo : safeHead };
}

async function probeStream(client, definition, safeHead, options) {
  const checks = {};
  const blockTag = definition.cursor <= safeHead ? toQuantity(definition.cursor) : toQuantity(safeHead);
  checks.checkpoint = await measure(() => client.request(
    'eth_getBlockByNumber', [blockTag, false]
  ));
  checks.historicalCall = await measure(() => client.request(
    'eth_call', [{ to: WETH_ADDRESS, data: TOTAL_SUPPLY_SELECTOR }, blockTag],
    { fallbackOnRpcError: true }
  ));
  const batchBlocks = Array.from({ length: 10 }, (_, index) => definition.cursor + BigInt(index))
    .filter((block) => block <= safeHead);
  checks.timestampBatch = await measure(() => client.requestBatch(batchBlocks.map((block) => ({
    method: 'eth_getBlockByNumber',
    params: [toQuantity(block), false],
  }))));

  const ranges = [];
  for (const rangeSize of options.rangeSizes) {
    for (let sample = 0; sample < options.samples; sample += 1) {
      const bounds = rangeBounds(definition.cursor, rangeSize, sample, safeHead);
      if (!bounds) continue;
      const filter = {
        ...definition.filter,
        fromBlock: toQuantity(bounds.fromBlock),
        toBlock: toQuantity(bounds.toBlock),
      };
      const result = await measure(() => client.request('eth_getLogs', [filter]));
      ranges.push({
        rangeSize,
        sample: sample + 1,
        fromBlock: bounds.fromBlock.toString(),
        toBlock: bounds.toBlock.toString(),
        ok: result.ok,
        elapsedMs: result.elapsedMs,
        logs: result.ok && Array.isArray(result.value) ? result.value.length : null,
        error: result.error || null,
      });
    }
  }
  return {
    cursor: definition.cursor.toString(),
    checks,
    ranges,
    complete: Object.values(checks).every((check) => check.ok)
      && ranges.length > 0
      && ranges.every((range) => range.ok),
  };
}

async function runPublicBackfillProbe(options = {}) {
  const client = options.client || createPublicClient(options);
  const repository = options.repository || createRobinhoodPersistenceRepository();
  if (client.providers?.length !== 1 || client.providers[0] !== 'robinhood-public') {
    throw new Error('Public backfill probe requires exactly the robinhood-public provider');
  }
  const rangeSizes = options.rangeSizes || DEFAULT_RANGE_SIZES;
  const samples = positiveInteger(options.samples, 1, MAX_SAMPLES);
  const confirmations = nonNegativeInteger(options.confirmations, 2, 1000);
  const chainId = parseQuantity(await client.request('eth_chainId'), 'eth_chainId');
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Unexpected chain ID ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
  }
  const head = parseQuantity(await client.request('eth_blockNumber'), 'eth_blockNumber');
  const safeHead = head >= BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
  const [discoveryCursor, marketCursor] = await Promise.all([
    repository.loadCursor('discovery'),
    repository.loadCursor('market'),
  ]);
  if (!discoveryCursor || !marketCursor) throw new Error('Both persistent cursors are required');
  const streams = {};
  for (const name of ['discovery', 'market']) {
    const cursor = name === 'discovery' ? discoveryCursor : marketCursor;
    streams[name] = await probeStream(
      client, streamDefinition(name, cursor), safeHead, { rangeSizes, samples }
    );
  }
  return {
    provider: 'robinhood-public',
    chainId: chainId.toString(),
    head: head.toString(),
    safeHead: safeHead.toString(),
    rangeSizes: [...rangeSizes],
    samples,
    streams,
    rpc: client.getMetrics?.()['robinhood-public'] || {},
    complete: Object.values(streams).every((stream) => stream.complete),
  };
}

function printReport(report, logger = console) {
  logger.log(`[RobinhoodPublicBackfillProbe] provider=${report.provider} chainId=${report.chainId} head=${report.head} safeHead=${report.safeHead} samples=${report.samples}`);
  for (const [name, stream] of Object.entries(report.streams)) {
    logger.log(`  stream=${name} cursor=${stream.cursor} complete=${stream.complete}`);
    for (const [check, result] of Object.entries(stream.checks)) {
      logger.log(`    check=${check} ok=${result.ok} elapsedMs=${result.elapsedMs}${result.error ? ` error=${result.error.code}:${result.error.message}` : ''}`);
    }
    for (const range of stream.ranges) {
      logger.log(`    logs rangeSize=${range.rangeSize} sample=${range.sample} blocks=${range.fromBlock}-${range.toBlock} ok=${range.ok} elapsedMs=${range.elapsedMs} logs=${range.logs ?? 'n/a'}${range.error ? ` error=${range.error.code}:${range.error.message}` : ''}`);
    }
  }
  logger.log(`  rpc=${JSON.stringify(report.rpc)}`);
}

async function main() {
  const report = await runPublicBackfillProbe({
    rpcUrl: process.env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL,
    timeoutMs: positiveInteger(process.env.ROBINHOOD_PUBLIC_PROBE_TIMEOUT_MS, 15_000, 60_000),
    confirmations: nonNegativeInteger(process.env.ROBINHOOD_CONFIRMATIONS, 2, 1000),
    rangeSizes: parseRangeSizes(process.env.ROBINHOOD_PUBLIC_PROBE_RANGE_SIZES),
    samples: positiveInteger(process.env.ROBINHOOD_PUBLIC_PROBE_SAMPLES, 1, MAX_SAMPLES),
  });
  printReport(report);
  if (!report.complete) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RobinhoodPublicBackfillProbe] fatal: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = {
  DEFAULT_RANGE_SIZES,
  DISCOVERY_FILTER,
  MARKET_FILTER,
  createPublicClient,
  parseRangeSizes,
  rangeBounds,
  runPublicBackfillProbe,
};
