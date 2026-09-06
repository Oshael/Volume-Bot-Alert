const db = require('../models/db');
const { isAdaptiveRangeError, toQuantity } = require('../services/evm-log-poller');
const {
  CANONICAL_CONTRACTS,
  ROBINHOOD_TOKENIZED_ASSETS,
} = require('../services/robinhood-market-policy');
const v3 = require('../services/uniswap-v3-decoder');
const repair = require('./repair-robinhood-v3-pruned-captures').__private;

const CHAIN_ID = 4663n;
const STOCKS = new Map(Object.entries(ROBINHOOD_TOKENIZED_ASSETS)
  .map(([symbol, address]) => [address.toLowerCase(), symbol]));
const STANDARD_QUOTES = new Set([
  CANONICAL_CONTRACTS.WETH.toLowerCase(), CANONICAL_CONTRACTS.USDG.toLowerCase(),
]);

function integer(value, fallback, min, max, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return resolved;
}

function block(value, label, fallback = null) {
  const resolved = String(value ?? fallback ?? '').trim();
  if (!/^\d+$/.test(resolved)) throw new Error(`${label} is required and must be a block`);
  return resolved;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = Object.fromEntries(argv.map((argument) => {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2] ?? 'true'];
  }));
  const fromBlock = block(args['from-block'], 'from-block');
  const toBlock = block(args['to-block'], 'to-block');
  const discoveryFromBlock = block(args['discovery-from-block'], 'discovery-from-block', '0');
  if (BigInt(toBlock) < BigInt(fromBlock)) throw new Error('to-block must not precede from-block');
  if (BigInt(toBlock) < BigInt(discoveryFromBlock)) {
    throw new Error('to-block must not precede discovery-from-block');
  }
  return {
    rpcUrl: String(args['rpc-url'] || env.ROBINHOOD_V3_REPAIR_RPC_URL || '').trim(),
    fromBlock, toBlock, discoveryFromBlock,
    discoveryRangeSize: integer(
      args['discovery-range-size'], 10_000_000, 1, 10_000_000, 'discovery-range-size'
    ),
    swapRangeSize: integer(args['swap-range-size'], 100_000, 1, 100_000, 'swap-range-size'),
    minRangeSize: integer(args['min-range-size'], 1, 1, 100_000, 'min-range-size'),
    addressBatchSize: integer(args['address-batch-size'], 100, 1, 500, 'address-batch-size'),
    identityBatchSize: integer(args['identity-batch-size'], 5_000, 1, 10_000, 'identity-batch-size'),
  };
}

function chunks(rows, size) {
  const output = [];
  for (let offset = 0; offset < rows.length; offset += size) output.push(rows.slice(offset, offset + size));
  return output;
}

async function fetchLogs(rpcClient, filter, fromBlock, toBlock, minRangeSize) {
  let logs;
  try {
    logs = await rpcClient.request('eth_getLogs', [{
      ...filter, fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock),
    }]);
    if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return an array');
  } catch (error) {
    const splittable = isAdaptiveRangeError(error) || error?.rpcCode === -32000;
    if (!splittable || toBlock - fromBlock + 1n <= BigInt(minRangeSize)) throw error;
    logs = null;
  }
  if (logs && logs.length <= 10_000) return [logs];
  if (toBlock - fromBlock + 1n <= BigInt(minRangeSize)) {
    throw new Error('Dense archive range cannot be split below min-range-size');
  }
  const midpoint = fromBlock + ((toBlock - fromBlock) / 2n);
  return [
    ...await fetchLogs(rpcClient, filter, fromBlock, midpoint, minRangeSize),
    ...await fetchLogs(rpcClient, filter, midpoint + 1n, toBlock, minRangeSize),
  ];
}

function classifyPool(pool) {
  const stock0 = STOCKS.get(pool.token0);
  const stock1 = STOCKS.get(pool.token1);
  if (!stock0 && !stock1) return null;
  if (stock0 && stock1) return { category: 'stock_stock', stockSymbols: [stock0, stock1] };
  const stockAddress = stock0 ? pool.token0 : pool.token1;
  const counterpartyAddress = stock0 ? pool.token1 : pool.token0;
  if (STANDARD_QUOTES.has(counterpartyAddress)) {
    return {
      category: 'stock_reference', stockSymbol: stock0 || stock1, stockAddress,
      quoteAddress: counterpartyAddress,
      quoteRoute: counterpartyAddress === CANONICAL_CONTRACTS.USDG.toLowerCase()
        ? 'direct_usdg'
        : 'via_weth',
    };
  }
  return {
    category: 'meme_stock_candidate',
    stockSymbol: stock0 || stock1,
    stockAddress,
    tokenAddress: counterpartyAddress,
    quoteAddress: stockAddress,
    quoteIndex: stock0 ? 0 : 1,
  };
}

function createRepository(database = db) {
  return Object.freeze({
    listRegistered: async (addresses) => {
      if (!addresses.length) return [];
      const result = await database.query(
        `SELECT market_key, lower(pool_address) AS pool_address,
                lower(token_address) AS token_address, lower(quote_address) AS quote_address,
                active
           FROM robinhood_pool_registry
          WHERE chain = 'robinhood' AND protocol = 'uniswap-v3'
            AND lower(pool_address) = ANY($1::text[])`, [addresses]
      );
      return result.rows;
    },
    classify: async (rows) => {
      if (!rows.length) return new Map();
      const input = rows.map((row) => ({
        transactionHash: row.transactionHash.toLowerCase(),
        logIndex: BigInt(row.logIndex).toString(),
      }));
      const result = await database.query(
        `WITH input AS MATERIALIZED (
           SELECT lower(item."transactionHash") AS transaction_hash,
                  item."logIndex"::bigint AS log_index
             FROM jsonb_to_recordset($1::jsonb) AS item(
               "transactionHash" text, "logIndex" text
             )
         )
         SELECT input.transaction_hash, input.log_index::text,
           EXISTS (SELECT 1 FROM robinhood_processed_logs processed
                    WHERE processed.chain = 'robinhood'
                      AND processed.transaction_hash = input.transaction_hash
                      AND processed.log_index = input.log_index) AS processed,
           EXISTS (SELECT 1 FROM robinhood_head_captures capture
                    WHERE capture.chain = 'robinhood'
                      AND capture.transaction_hash = input.transaction_hash
                      AND capture.log_index = input.log_index) AS captured
         FROM input`, [JSON.stringify(input)]
      );
      return new Map(result.rows.map((row) => [
        `${row.transaction_hash}:${row.log_index}`,
        { processed: row.processed, captured: row.captured },
      ]));
    },
  });
}

function identity(log) {
  return `${String(log.transactionHash).toLowerCase()}:${BigInt(log.logIndex)}`;
}

function registryAssessment(pool, registry) {
  if (!registry) return { status: 'missing', orientationMatches: false };
  const orientationMatches = registry.token_address === pool.tokenAddress
    && registry.quote_address === pool.quoteAddress;
  return {
    status: !orientationMatches ? 'orientation_mismatch' : (registry.active ? 'ready' : 'inactive'),
    orientationMatches,
  };
}

async function scanReferenceInitializations(options, rpcClient, references) {
  const initialized = new Map();
  if (!references.length) return initialized;
  let cursor = references.reduce((minimum, pool) => {
    const created = BigInt(pool.blockNumber);
    return created < minimum ? created : minimum;
  }, BigInt(options.toBlock));
  const end = BigInt(options.toBlock);
  while (cursor <= end) {
    const requestedEnd = cursor + BigInt(options.discoveryRangeSize) - 1n;
    const rangeEnd = requestedEnd < end ? requestedEnd : end;
    const active = references.filter((pool) => BigInt(pool.blockNumber) <= rangeEnd);
    for (const addresses of chunks(active.map((pool) => pool.poolAddress), options.addressBatchSize)) {
      const leaves = await fetchLogs(rpcClient, {
        address: addresses.length === 1 ? addresses[0] : addresses,
        topics: [v3.TOPICS.initialize],
      }, cursor, rangeEnd, options.minRangeSize);
      for (const logs of leaves) {
        for (const log of logs.filter((entry) => entry?.removed !== true)) {
          const address = String(log.address || '').toLowerCase();
          const blockNumber = BigInt(log.blockNumber).toString();
          const previous = initialized.get(address);
          if (previous == null || BigInt(blockNumber) < BigInt(previous)) {
            initialized.set(address, blockNumber);
          }
        }
      }
    }
    cursor = rangeEnd + 1n;
    console.log(JSON.stringify({
      event: 'v3_stock_pair_audit_progress', phase: 'reference-initialization',
      nextBlock: cursor.toString(), initializedReferencePools: initialized.size,
    }));
  }
  return initialized;
}

function referenceIndex(references) {
  const byStock = new Map();
  for (const reference of references) {
    if (reference.initializedBlock == null) continue;
    const rows = byStock.get(reference.stockAddress) || [];
    rows.push(reference);
    byStock.set(reference.stockAddress, rows);
  }
  for (const rows of byStock.values()) {
    rows.sort((left, right) => (
      (left.quoteRoute === 'direct_usdg' ? 0 : 1) - (right.quoteRoute === 'direct_usdg' ? 0 : 1)
      || left.fee - right.fee
    ));
  }
  return byStock;
}

function priceRoute(pool, blockNumber, referencesByStock) {
  return (referencesByStock.get(pool.stockAddress) || [])
    .find((reference) => BigInt(reference.initializedBlock) <= blockNumber)?.quoteRoute || null;
}

function recordSwap(poolStats, log, state, referencesByStock) {
  const blockNumber = BigInt(log.blockNumber);
  poolStats.archiveSwaps += 1;
  poolStats.firstSwapBlock = poolStats.firstSwapBlock == null
    ? blockNumber.toString()
    : (blockNumber < BigInt(poolStats.firstSwapBlock)
      ? blockNumber.toString() : poolStats.firstSwapBlock);
  poolStats.lastSwapBlock = poolStats.lastSwapBlock == null
    ? blockNumber.toString()
    : (blockNumber > BigInt(poolStats.lastSwapBlock)
      ? blockNumber.toString() : poolStats.lastSwapBlock);
  const route = priceRoute(poolStats, blockNumber, referencesByStock);
  if (route === 'direct_usdg') poolStats.historicalQuoteCoverage.directUsdg += 1;
  else if (route === 'via_weth') poolStats.historicalQuoteCoverage.viaWeth += 1;
  else poolStats.historicalQuoteCoverage.uncovered += 1;
  if (state.processed) poolStats.existingProcessed += 1;
  else if (state.captured) poolStats.existingCaptures += 1;
  else poolStats.missing += 1;
}

async function scanDiscovery(options, rpcClient, decodePoolCreated) {
  const pools = new Map();
  let cursor = BigInt(options.discoveryFromBlock);
  const end = BigInt(options.toBlock);
  while (cursor <= end) {
    const requestedEnd = cursor + BigInt(options.discoveryRangeSize) - 1n;
    const rangeEnd = requestedEnd < end ? requestedEnd : end;
    const leaves = await fetchLogs(rpcClient, {
      address: v3.ROBINHOOD_V3_FACTORY, topics: [v3.TOPICS.poolCreated],
    }, cursor, rangeEnd, options.minRangeSize);
    for (const logs of leaves) {
      for (const log of logs) {
        const pool = decodePoolCreated(log);
        const classification = classifyPool(pool);
        if (classification) pools.set(pool.poolAddress, { ...pool, ...classification });
      }
    }
    cursor = rangeEnd + 1n;
    console.log(JSON.stringify({
      event: 'v3_stock_pair_audit_progress', phase: 'discovery',
      nextBlock: cursor.toString(), stockPools: pools.size,
    }));
  }
  return [...pools.values()];
}

async function auditSwaps(options, rpcClient, repository, candidates, referencesByStock = new Map()) {
  const stats = new Map(candidates.map((pool) => [pool.poolAddress, {
    poolAddress: pool.poolAddress, tokenAddress: pool.tokenAddress, quoteAddress: pool.quoteAddress,
    stockAddress: pool.stockAddress, stockSymbol: pool.stockSymbol,
    createdBlock: pool.blockNumber, archiveSwaps: 0,
    existingProcessed: 0, existingCaptures: 0, missing: 0,
    firstSwapBlock: null, lastSwapBlock: null,
    historicalQuoteCoverage: { directUsdg: 0, viaWeth: 0, uncovered: 0 },
  }]));
  if (!candidates.length) return [...stats.values()];
  const requestedStart = BigInt(options.fromBlock);
  const firstCreation = candidates.reduce((minimum, pool) => {
    const created = BigInt(pool.blockNumber);
    return created < minimum ? created : minimum;
  }, BigInt(options.toBlock));
  const auditStart = firstCreation > requestedStart ? firstCreation : requestedStart;
  let completedRanges = 0;
  const totalRanges = Math.ceil(
    Number(BigInt(options.toBlock) - auditStart + 1n) / options.swapRangeSize
  );
  let cursor = auditStart;
  const end = BigInt(options.toBlock);
  while (cursor <= end) {
    const requestedEnd = cursor + BigInt(options.swapRangeSize) - 1n;
    const rangeEnd = requestedEnd < end ? requestedEnd : end;
    const activePools = candidates.filter((pool) => BigInt(pool.blockNumber) <= rangeEnd);
    const addressBatches = chunks(
      activePools.map((pool) => pool.poolAddress), options.addressBatchSize
    );
    for (const addresses of addressBatches) {
      const leaves = await fetchLogs(rpcClient, {
        address: addresses.length === 1 ? addresses[0] : addresses,
        topics: [v3.TOPICS.swap],
      }, cursor, rangeEnd, options.minRangeSize);
      for (const logs of leaves) {
        const unique = [...new Map(logs.filter((log) => log?.removed !== true)
          .map((log) => [identity(log), log])).values()];
        for (const batch of chunks(unique, options.identityBatchSize)) {
          const classified = await repository.classify(batch);
          for (const log of batch) {
            const poolStats = stats.get(String(log.address).toLowerCase());
            if (!poolStats) continue;
            recordSwap(poolStats, log, classified.get(identity(log)) || {}, referencesByStock);
          }
        }
      }
    }
    completedRanges += 1;
    cursor = rangeEnd + 1n;
    console.log(JSON.stringify({
      event: 'v3_stock_pair_audit_progress', phase: 'swaps', completedRanges, totalRanges,
      activePools: activePools.length, addressBatches: addressBatches.length,
      nextBlock: cursor.toString(),
      progressPct: Number(((completedRanges / totalRanges) * 100).toFixed(2)),
    }));
  }
  return [...stats.values()];
}

async function runAudit(options, deps = {}) {
  if (!options.rpcUrl && !deps.rpcClient) throw new Error('Archive RPC URL is required');
  const rpcClient = deps.rpcClient || repair.createArchiveClient(options.rpcUrl);
  const repository = deps.repository || createRepository(deps.database || db);
  if (BigInt(await rpcClient.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('Archive RPC is not on Robinhood Chain');
  }
  const stockPools = await scanDiscovery(
    options, rpcClient, deps.decodePoolCreated || v3.decodePoolCreated
  );
  const candidates = stockPools.filter((pool) => pool.category === 'meme_stock_candidate');
  const referencePools = stockPools.filter((pool) => pool.category === 'stock_reference');
  const initialized = await scanReferenceInitializations(options, rpcClient, referencePools);
  const references = referencePools.map((pool) => ({
    ...pool, initializedBlock: initialized.get(pool.poolAddress) || null,
  }));
  const registeredRows = await repository.listRegistered(
    [...candidates, ...references].map((pool) => pool.poolAddress)
  );
  const registered = new Map(registeredRows.map((row) => [row.pool_address, row]));
  const audited = await auditSwaps(options, rpcClient, repository, candidates, referenceIndex(references));
  const rows = audited.map((row) => {
    const registry = registered.get(row.poolAddress) || null;
    const registryAssessmentResult = registryAssessment(row, registry);
    const covered = row.historicalQuoteCoverage.directUsdg
      + row.historicalQuoteCoverage.viaWeth;
    const coveragePct = row.archiveSwaps === 0
      ? 100
      : Number(((covered / row.archiveSwaps) * 100).toFixed(2));
    const blockers = [];
    if (registryAssessmentResult.status !== 'ready') blockers.push(`registry_${registryAssessmentResult.status}`);
    if (row.historicalQuoteCoverage.uncovered > 0) blockers.push('historical_stock_usd_uncovered');
    if (row.missing > 0) blockers.push('stock_quote_valuation_not_implemented');
    return {
      ...row, registry, registryAssessment: registryAssessmentResult,
      historicalQuoteCoverage: {
        ...row.historicalQuoteCoverage, covered, coveragePct,
        mode: 'initialized_reference_pool',
      },
      backfillReadiness: { ready: blockers.length === 0, blockers },
    };
  })
    .sort((left, right) => right.missing - left.missing || right.archiveSwaps - left.archiveSwaps);
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const coverage = rows.reduce((total, row) => ({
    directUsdg: total.directUsdg + row.historicalQuoteCoverage.directUsdg,
    viaWeth: total.viaWeth + row.historicalQuoteCoverage.viaWeth,
    uncovered: total.uncovered + row.historicalQuoteCoverage.uncovered,
  }), { directUsdg: 0, viaWeth: 0, uncovered: 0 });
  const covered = coverage.directUsdg + coverage.viaWeth;
  return {
    mode: 'read-only', discoveryFromBlock: options.discoveryFromBlock,
    fromBlock: options.fromBlock, toBlock: options.toBlock,
    stockReferencePools: stockPools.filter((pool) => pool.category === 'stock_reference').length,
    stockStockPools: stockPools.filter((pool) => pool.category === 'stock_stock').length,
    candidatePools: rows.length,
    registeredCandidatePools: rows.filter((row) => row.registry).length,
    registryReadyCandidatePools: rows.filter((row) => row.registryAssessment.status === 'ready').length,
    registryMismatchCandidatePools: rows.filter(
      (row) => row.registryAssessment.status === 'orientation_mismatch'
    ).length,
    archiveSwapLogs: sum('archiveSwaps'), existingProcessed: sum('existingProcessed'),
    existingCaptures: sum('existingCaptures'), missing: sum('missing'),
    historicalQuoteCoverage: {
      ...coverage, covered,
      coveragePct: covered + coverage.uncovered === 0
        ? 100
        : Number(((covered / (covered + coverage.uncovered)) * 100).toFixed(2)),
      mode: 'initialized_reference_pool',
    },
    referencePools: references.map((pool) => {
      const registry = registered.get(pool.poolAddress) || null;
      return {
        poolAddress: pool.poolAddress, stockSymbol: pool.stockSymbol,
        stockAddress: pool.stockAddress, quoteAddress: pool.quoteAddress,
        quoteRoute: pool.quoteRoute, fee: pool.fee, tickSpacing: pool.tickSpacing,
        createdBlock: pool.blockNumber, initializedBlock: pool.initializedBlock,
        registry, registryAssessment: registryAssessment(pool, registry),
      };
    }),
    candidates: rows,
  };
}

async function run() {
  try {
    console.log(JSON.stringify(await runAudit(parseArgs()), null, 2));
  } catch (error) {
    console.error('[RobinhoodV3StockPairAudit]', error.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  runAudit,
  __private: {
    classifyPool, createRepository, fetchLogs, parseArgs, priceRoute,
    recordSwap, referenceIndex, registryAssessment, scanReferenceInitializations,
  },
};
