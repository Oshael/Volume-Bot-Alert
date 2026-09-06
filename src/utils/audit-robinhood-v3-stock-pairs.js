const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const { isAdaptiveRangeError, toQuantity } = require('../services/evm-log-poller');
const {
  CANONICAL_CONTRACTS,
  ROBINHOOD_TOKENIZED_ASSETS,
} = require('../services/robinhood-market-policy');
const v3 = require('../services/uniswap-v3-decoder');
const repair = require('./repair-robinhood-v3-pruned-captures').__private;

const CHAIN_ID = 4663n;
const CHECKPOINT_VERSION = 1;
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
  const checkpointFile = String(
    args['checkpoint-file'] || env.ROBINHOOD_V3_STOCK_AUDIT_CHECKPOINT_FILE || ''
  ).trim() || null;
  const maxRanges = integer(args['max-ranges'], 0, 0, 10_000_000, 'max-ranges');
  if (maxRanges > 0 && !checkpointFile) {
    throw new Error('checkpoint-file is required when max-ranges is set');
  }
  const reportFile = String(
    args['report-file'] || (checkpointFile ? `${checkpointFile}.report.json` : '')
  ).trim() || null;
  if (checkpointFile && reportFile && path.resolve(checkpointFile) === path.resolve(reportFile)) {
    throw new Error('report-file must differ from checkpoint-file');
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
    maxRanges,
    checkpointFile,
    reportFile,
  };
}

function createJsonStore(filename, label) {
  if (!filename) return Object.freeze({ load: async () => null, save: async () => {} });
  const resolved = path.resolve(filename);
  return Object.freeze({
    load: async () => {
      try {
        return JSON.parse(await fs.readFile(resolved, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`Cannot read ${label} ${resolved}: ${error.message}`);
      }
    },
    save: async (value) => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.tmp-${process.pid}`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, resolved);
      } finally {
        await fs.unlink(temporary).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    },
  });
}

function emptyAuditState(options) {
  return {
    version: CHECKPOINT_VERSION,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    discoveryFromBlock: options.discoveryFromBlock,
    phase: 'discovery',
    totalRanges: 0,
    discovery: { nextBlock: options.discoveryFromBlock, completed: false, pools: [] },
    references: { nextBlock: null, completed: false, initialized: {} },
    swaps: { nextBlock: null, completed: false, completedRanges: 0, stats: [] },
  };
}

function restoreAuditState(saved, options) {
  if (!saved) return emptyAuditState(options);
  if (saved.version !== CHECKPOINT_VERSION) throw new Error('Checkpoint version is invalid');
  for (const key of ['fromBlock', 'toBlock', 'discoveryFromBlock']) {
    if (String(saved[key]) !== String(options[key])) {
      throw new Error(`Checkpoint ${key} does not match this execution`);
    }
  }
  if (!['discovery', 'reference-initialization', 'swaps', 'complete'].includes(saved.phase)) {
    throw new Error('Checkpoint phase is invalid');
  }
  return saved;
}

function executionSnapshot(state, report = null) {
  return {
    mode: 'read-only', completed: state.phase === 'complete', phase: state.phase,
    updatedAt: new Date().toISOString(), fromBlock: state.fromBlock, toBlock: state.toBlock,
    discoveryFromBlock: state.discoveryFromBlock, totalRanges: state.totalRanges,
    progress: {
      discovery: {
        completed: state.discovery.completed, nextBlock: state.discovery.nextBlock,
        stockPools: state.discovery.pools.length,
      },
      references: {
        completed: state.references.completed, nextBlock: state.references.nextBlock,
        initializedPools: Object.keys(state.references.initialized).length,
      },
      swaps: {
        completed: state.swaps.completed, nextBlock: state.swaps.nextBlock,
        completedRanges: state.swaps.completedRanges,
        archiveSwapLogs: state.swaps.stats.reduce((total, row) => total + row.archiveSwaps, 0),
        missing: state.swaps.stats.reduce((total, row) => total + row.missing, 0),
      },
    },
    partial: {
      stockPools: state.discovery.pools,
      initializedReferences: state.references.initialized,
      candidates: state.swaps.stats,
    },
    report,
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

async function scanReferenceInitializations(options, rpcClient, references, state, control) {
  const initialized = new Map(Object.entries(state.initialized));
  if (!references.length) {
    state.completed = true;
    state.nextBlock = (BigInt(options.toBlock) + 1n).toString();
    return initialized;
  }
  let cursor = state.nextBlock == null
    ? references.reduce((minimum, pool) => {
      const created = BigInt(pool.blockNumber);
      return created < minimum ? created : minimum;
    }, BigInt(options.toBlock))
    : BigInt(state.nextBlock);
  const end = BigInt(options.toBlock);
  while (cursor <= end && control.canRun()) {
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
    state.nextBlock = cursor.toString();
    state.completed = cursor > end;
    state.initialized = Object.fromEntries(initialized);
    await control.afterRange();
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

async function scanDiscovery(options, rpcClient, decodePoolCreated, state, control) {
  const pools = new Map(state.pools.map((pool) => [pool.poolAddress, pool]));
  let cursor = BigInt(state.nextBlock);
  const end = BigInt(options.toBlock);
  while (cursor <= end && control.canRun()) {
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
    state.nextBlock = cursor.toString();
    state.completed = cursor > end;
    state.pools = [...pools.values()];
    await control.afterRange();
    console.log(JSON.stringify({
      event: 'v3_stock_pair_audit_progress', phase: 'discovery',
      nextBlock: cursor.toString(), stockPools: pools.size,
    }));
  }
  return [...pools.values()];
}

function newSwapStats(candidates) {
  return candidates.map((pool) => ({
    poolAddress: pool.poolAddress, tokenAddress: pool.tokenAddress, quoteAddress: pool.quoteAddress,
    stockAddress: pool.stockAddress, stockSymbol: pool.stockSymbol,
    createdBlock: pool.blockNumber, archiveSwaps: 0,
    existingProcessed: 0, existingCaptures: 0, missing: 0,
    firstSwapBlock: null, lastSwapBlock: null,
    historicalQuoteCoverage: { directUsdg: 0, viaWeth: 0, uncovered: 0 },
  }));
}

async function auditSwaps(
  options, rpcClient, repository, candidates, referencesByStock, state, control
) {
  const seeded = state.stats.length ? state.stats : newSwapStats(candidates);
  const stats = new Map(seeded.map((row) => [row.poolAddress, row]));
  if (!candidates.length) {
    state.completed = true;
    state.nextBlock = (BigInt(options.toBlock) + 1n).toString();
    return [...stats.values()];
  }
  const requestedStart = BigInt(options.fromBlock);
  const firstCreation = candidates.reduce((minimum, pool) => {
    const created = BigInt(pool.blockNumber);
    return created < minimum ? created : minimum;
  }, BigInt(options.toBlock));
  const auditStart = firstCreation > requestedStart ? firstCreation : requestedStart;
  let completedRanges = state.completedRanges;
  const totalRanges = Math.ceil(
    Number(BigInt(options.toBlock) - auditStart + 1n) / options.swapRangeSize
  );
  let cursor = state.nextBlock == null ? auditStart : BigInt(state.nextBlock);
  const end = BigInt(options.toBlock);
  while (cursor <= end && control.canRun()) {
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
    state.nextBlock = cursor.toString();
    state.completed = cursor > end;
    state.completedRanges = completedRanges;
    state.stats = [...stats.values()];
    await control.afterRange();
    console.log(JSON.stringify({
      event: 'v3_stock_pair_audit_progress', phase: 'swaps', completedRanges, totalRanges,
      activePools: activePools.length, addressBatches: addressBatches.length,
      nextBlock: cursor.toString(),
      progressPct: Number(((completedRanges / totalRanges) * 100).toFixed(2)),
    }));
  }
  return [...stats.values()];
}

function buildReport(options, stockPools, references, audited, registeredRows) {
  const registered = new Map(registeredRows.map((row) => [row.pool_address, row]));
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

async function runAudit(options, deps = {}) {
  if (!options.rpcUrl && !deps.rpcClient) throw new Error('Archive RPC URL is required');
  const rpcClient = deps.rpcClient || repair.createArchiveClient(options.rpcUrl);
  const repository = deps.repository || createRepository(deps.database || db);
  const checkpoint = deps.checkpoint || createJsonStore(options.checkpointFile, 'checkpoint');
  const reportStore = deps.reportStore || createJsonStore(options.reportFile, 'report');
  if (BigInt(await rpcClient.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('Archive RPC is not on Robinhood Chain');
  }
  const state = restoreAuditState(await checkpoint.load(), options);
  let runRanges = 0;
  const persist = async (report = null) => {
    await checkpoint.save(state);
    await reportStore.save(executionSnapshot(state, report));
  };
  const control = {
    canRun: () => !options.maxRanges || runRanges < options.maxRanges,
    afterRange: async () => {
      runRanges += 1;
      state.totalRanges += 1;
      await persist();
    },
  };

  if (state.phase === 'discovery') {
    await scanDiscovery(
      options, rpcClient, deps.decodePoolCreated || v3.decodePoolCreated,
      state.discovery, control
    );
    if (!state.discovery.completed) return executionSnapshot(state);
    state.phase = 'reference-initialization';
    await persist();
  }
  const stockPools = state.discovery.pools;
  const referencePools = stockPools.filter((pool) => pool.category === 'stock_reference');
  if (state.phase === 'reference-initialization') {
    await scanReferenceInitializations(
      options, rpcClient, referencePools, state.references, control
    );
    if (!state.references.completed) return executionSnapshot(state);
    state.phase = 'swaps';
    await persist();
  }
  const initialized = new Map(Object.entries(state.references.initialized));
  const references = referencePools.map((pool) => ({
    ...pool, initializedBlock: initialized.get(pool.poolAddress) || null,
  }));
  const candidates = stockPools.filter((pool) => pool.category === 'meme_stock_candidate');
  if (state.phase === 'swaps') {
    await auditSwaps(
      options, rpcClient, repository, candidates, referenceIndex(references),
      state.swaps, control
    );
    if (!state.swaps.completed) return executionSnapshot(state);
    state.phase = 'complete';
  }
  const registeredRows = await repository.listRegistered(
    [...candidates, ...references].map((pool) => pool.poolAddress)
  );
  const report = buildReport(options, stockPools, references, state.swaps.stats, registeredRows);
  await persist(report);
  return report;
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
    buildReport, classifyPool, createJsonStore, createRepository, emptyAuditState,
    executionSnapshot, fetchLogs, parseArgs, priceRoute, recordSwap, referenceIndex,
    registryAssessment, restoreAuditState, scanReferenceInitializations,
  },
};
