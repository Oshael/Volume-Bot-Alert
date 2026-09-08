require('dotenv').config();

const db = require('../models/db');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createBlockTimestampEnricher } = require('../services/evm-log-enrichment');
const {
  CANONICAL_CONTRACTS, ROBINHOOD_TOKENIZED_ASSETS,
} = require('../services/robinhood-market-policy');
const v2 = require('../services/uniswap-v2-decoder');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');
const holderRecovery = require('./recover-robinhood-holder-deployments');
const { fetchLogs } = require('./audit-robinhood-v3-stock-pairs').__private;

const CHAIN_ID = 4663n;
const CONFIRM_FLAG = '--confirm-robinhood-onboarding-backfill';
const STOCKS = new Set(Object.values(ROBINHOOD_TOKENIZED_ASSETS).map((value) => value.toLowerCase()));
const STANDARD_QUOTES = new Set([
  CANONICAL_CONTRACTS.WETH.toLowerCase(),
  CANONICAL_CONTRACTS.USDG.toLowerCase(),
  v4.NATIVE_CURRENCY,
]);
const PROTOCOLS = Object.freeze([
  {
    protocol: 'uniswap-v2', address: v2.ROBINHOOD_V2_FACTORY,
    topic: v2.TOPICS.pairCreated, decode: v2.decodePairCreated,
  },
  {
    protocol: 'uniswap-v3', address: v3.ROBINHOOD_V3_FACTORY,
    topic: v3.TOPICS.poolCreated, decode: v3.decodePoolCreated,
  },
  {
    protocol: 'uniswap-v4', address: v4.ROBINHOOD_V4_POOL_MANAGER,
    topic: v4.TOPICS.initialize, decode: v4.decodeInitialize,
  },
]);

function integer(value, fallback, min, max, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return resolved;
}

function block(value, fallback, label) {
  const resolved = String(value ?? fallback ?? '').trim();
  if (!/^\d+$/.test(resolved)) throw new Error(`${label} must be a block`);
  return resolved;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const values = {};
  for (const argument of argv) {
    if (argument === CONFIRM_FLAG) {
      values.confirm = true;
      continue;
    }
    const match = String(argument).match(/^--([^=]+)=(.+)$/);
    if (!match || values[match[1]] !== undefined) throw new Error(`invalid argument: ${argument}`);
    values[match[1]] = match[2];
  }
  return Object.freeze({
    confirm: values.confirm === true,
    rpcUrl: String(values['rpc-url'] || env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim(),
    fromBlock: block(values['from-block'], '0', '--from-block'),
    toBlock: values['to-block'] == null ? null : block(values['to-block'], null, '--to-block'),
    rangeSize: integer(values['range-size'], 10_000_000, 1, 10_000_000, '--range-size'),
    minRangeSize: integer(values['min-range-size'], 1, 1, 100_000, '--min-range-size'),
    holderLimit: integer(values['holder-limit'], 50_000, 1, 100_000, '--holder-limit'),
    holderConcurrency: integer(values['holder-concurrency'], 24, 1, 64, '--holder-concurrency'),
    timeoutMs: integer(values['timeout-ms'], 30_000, 1000, 60_000, '--timeout-ms'),
  });
}

function assets(event) {
  return [event.token0 || event.currency0, event.token1 || event.currency1]
    .map((value) => String(value || '').toLowerCase());
}

function decodeStockPair(log, specification) {
  const initial = specification.decode(log);
  const [asset0, asset1] = assets(initial);
  const asset0Stock = STOCKS.has(asset0);
  const asset1Stock = STOCKS.has(asset1);
  if (asset0Stock === asset1Stock) return null;
  const stock = asset0Stock ? asset0 : asset1;
  const token = asset0Stock ? asset1 : asset0;
  if (STANDARD_QUOTES.has(token)) return null;
  const event = specification.decode(log, { quoteAddresses: [stock] });
  if (!event.tracked || event.tokenAddress !== token || event.quoteAddress !== stock) {
    throw new Error(`invalid ${specification.protocol} stock-pair orientation`);
  }
  return event;
}

function createRuntime(options, deps = {}) {
  if (!options.rpcUrl && !deps.rpcClient) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  const rpcClient = deps.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'robinhood-onboarding-archive', url: options.rpcUrl }],
    timeoutMs: options.timeoutMs,
    maxRetries: 1,
  });
  return Object.freeze({
    rpcClient,
    timestamps: deps.timestamps || createBlockTimestampEnricher({
      rpcClient, concurrency: 24, batchSize: 100, batchConcurrency: 2,
    }),
    persistence: deps.persistence || createRobinhoodPersistenceRepository({
      database: deps.database || db,
    }),
  });
}

async function scanProtocol(options, runtime, specification, toBlock, logger) {
  let cursor = BigInt(options.fromBlock);
  const end = BigInt(toBlock);
  const totals = { scannedLogs: 0, stockPairs: 0, upsertedPools: 0, ranges: 0 };
  while (cursor <= end) {
    const requestedEnd = cursor + BigInt(options.rangeSize) - 1n;
    const rangeEnd = requestedEnd < end ? requestedEnd : end;
    const leaves = await fetchLogs(runtime.rpcClient, {
      address: specification.address,
      topics: [specification.topic],
    }, cursor, rangeEnd, options.minRangeSize);
    const logs = leaves.flat().filter((log) => log?.removed !== true);
    totals.scannedLogs += logs.length;
    const candidates = logs.filter((log) => decodeStockPair(log, specification) != null);
    const enriched = await runtime.timestamps.enrich(candidates);
    const events = enriched.map((log) => decodeStockPair(log, specification));
    totals.stockPairs += events.length;
    if (options.confirm && events.length) {
      const result = await runtime.persistence.upsertRecoveredPools(events);
      totals.upsertedPools += result.upsertedPools;
    }
    totals.ranges += 1;
    cursor = rangeEnd + 1n;
    logger.log(JSON.stringify({
      event: 'robinhood_stock_pair_backfill_progress',
      protocol: specification.protocol,
      nextBlock: cursor.toString(),
      ...totals,
    }));
  }
  return totals;
}

async function backfillStockPairs(options, deps = {}) {
  const runtime = deps.runtime || createRuntime(options, deps);
  const logger = deps.logger || console;
  if (BigInt(await runtime.rpcClient.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('archive RPC is not Robinhood Chain');
  }
  const toBlock = options.toBlock
    ?? BigInt(await runtime.rpcClient.request('eth_blockNumber')).toString();
  if (BigInt(toBlock) < BigInt(options.fromBlock)) {
    throw new Error('--to-block must not precede --from-block');
  }
  const protocols = {};
  for (const specification of PROTOCOLS) {
    protocols[specification.protocol] = await scanProtocol(
      options, runtime, specification, toBlock, logger
    );
  }
  return {
    mode: options.confirm ? 'apply' : 'read-only',
    fromBlock: options.fromBlock,
    toBlock,
    stockPairs: Object.values(protocols).reduce((sum, value) => sum + value.stockPairs, 0),
    upsertedPools: Object.values(protocols).reduce((sum, value) => sum + value.upsertedPools, 0),
    protocols,
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv, deps.env);
  const logger = deps.logger || console;
  const stockPairs = await backfillStockPairs(options, deps);
  const holders = await (deps.holderMain || holderRecovery.main)([], {
    options: {
      confirm: options.confirm,
      limit: options.holderLimit,
      concurrency: options.holderConcurrency,
      timeoutMs: options.timeoutMs,
    },
    logger,
    ...(deps.holderDeps || {}),
  });
  const report = {
    mode: options.confirm ? 'apply' : 'read-only',
    stockPairs,
    holders,
  };
  logger.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood onboarding backfill failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, backfillStockPairs, decodeStockPair, main, parseArgs,
  __private: { createRuntime, scanProtocol },
};
