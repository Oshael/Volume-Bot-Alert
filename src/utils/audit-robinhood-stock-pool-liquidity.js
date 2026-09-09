'use strict';

const { parseArgs } = require('node:util');
const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createErc20MetadataReader } = require('../services/evm-erc20-metadata');
const {
  CANONICAL_CONTRACTS, ROBINHOOD_TOKENIZED_ASSETS, buildLiquidityAssessment,
} = require('../services/robinhood-market-policy');
const { formatDecimal, multiply, parseDecimal, rational } = require('../services/evm-market-metrics');
const { mergeRangeDeltas } = require('../services/uniswap-v4-liquidity');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');
const { fetchLogs } = require('./audit-robinhood-v3-stock-pairs').__private;

const CHAIN_ID = 4663n;
const TARGET_DEFAULT = '0x98096d17e191b3da1d5f99a6d7b3584351b11e18';
const SLOT0_SELECTOR = '0x3850c7bd';
const V4_SLOT0_SELECTOR = '0xc815641c';
const V4_LIQUIDITY_SELECTOR = '0xfa6793d5';

function address(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function integer(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function options(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    'token-address': { type: 'string' },
    'archive-rpc-url': { type: 'string' },
    'live-rpc-url': { type: 'string' },
    'range-size': { type: 'string' },
    'expected-total-usd': { type: 'string' },
  } });
  const expected = values['expected-total-usd'] == null
    ? null : String(values['expected-total-usd']).trim();
  if (expected != null) parseDecimal(expected, 'expected total USD');
  return Object.freeze({
    tokenAddress: address(values['token-address'] || TARGET_DEFAULT, 'token address'),
    archiveRpcUrl: String(values['archive-rpc-url'] || env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim(),
    liveRpcUrl: String(values['live-rpc-url']
      || env.ROBINHOOD_CANONICAL_LIQUIDITY_RPC_URL || env.ROBINHOOD_RPC_URL || '').trim(),
    rangeSize: integer(values['range-size'], 2_000_000, 1, 5_000_000, 'range size'),
    expectedTotalUsd: expected,
  });
}

function rpc(url, name) {
  if (!url) throw new Error(`${name} RPC URL is required`);
  return createEvmJsonRpcClient({
    providers: [{ name, url }], timeoutMs: 30_000, maxRetries: 1,
  });
}

function word(data, index, bits, label) {
  const raw = String(data || '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{64})+$/.test(raw)) throw new Error(`${label} is malformed`);
  const value = BigInt(`0x${raw.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
  if (value >= 1n << BigInt(bits)) throw new Error(`${label} exceeds uint${bits}`);
  return value;
}

function bytes32Call(selector, value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('pool id is invalid');
  return `${selector}${normalized.slice(2)}`;
}

function quoteIndex(pool) {
  const token = pool.token_address;
  if (pool.currency0 === token && pool.currency1 !== token) return 1;
  if (pool.currency1 === token && pool.currency0 !== token) return 0;
  throw new Error(`pool orientation is invalid for ${pool.market_key}`);
}

function tokenUsd(protocol, sqrtPriceX96, pool, tokenDecimals, quoteDecimals, quoteUsd) {
  const index = quoteIndex(pool);
  const exact = protocol === 'uniswap-v3'
    ? v3.exactPriceRatio(sqrtPriceX96, { quoteIndex: index })
    : v4.exactPriceRatio(sqrtPriceX96, { quoteIndex: index });
  return formatDecimal(multiply(
    rational(exact.numerator, exact.denominator),
    rational(10n ** BigInt(tokenDecimals), 10n ** BigInt(quoteDecimals)),
    parseDecimal(quoteUsd)
  ), 80);
}

function add(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

async function candidates(database, tokenAddress) {
  const stocks = Object.entries(ROBINHOOD_TOKENIZED_ASSETS)
    .map(([symbol, stockAddress]) => ({ symbol, address: stockAddress.toLowerCase() }));
  const { rows } = await database.query(
    `WITH stocks AS MATERIALIZED (
       SELECT * FROM jsonb_to_recordset($2::jsonb) item(symbol text, address text)
     ), targets AS MATERIALIZED (
       SELECT stocks.symbol, registry.*
       FROM stocks JOIN robinhood_pool_registry registry
         ON registry.chain='robinhood' AND registry.active=TRUE
        AND registry.protocol='uniswap-v4'
        AND registry.token_address=$1 AND registry.quote_address=stocks.address
     ) SELECT targets.*, reference.pool_address AS ref_pool_address,
              reference.market_key AS ref_market_key,
              reference.token_address AS ref_token_address,
              reference.quote_address AS ref_quote_address,
              reference.currency0 AS ref_currency0,
              reference.currency1 AS ref_currency1
       FROM targets JOIN LATERAL (
         SELECT registry.* FROM robinhood_pool_registry registry
         LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
           USING (chain, protocol, market_key)
         WHERE registry.chain='robinhood' AND registry.active=TRUE
           AND registry.protocol='uniswap-v3'
           AND registry.token_address=targets.quote_address
           AND registry.quote_address=$3
         ORDER BY snapshot.liquidity_usd DESC NULLS LAST LIMIT 1
       ) reference ON TRUE
       ORDER BY targets.symbol`,
    [tokenAddress, JSON.stringify(stocks), CANONICAL_CONTRACTS.USDG]
  );
  if (!rows.length) throw new Error('no active token/stock V4 pools with USDG references found');
  return rows;
}

async function request(client, label, method, params = []) {
  try {
    return await client.request(method, params);
  } catch (error) {
    const wrapped = new Error(`${label}: ${error.message}`);
    wrapped.code = error.code;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function scanRanges(client, rows, toBlock, rangeSize, logger) {
  const first = rows.reduce((minimum, row) => {
    const block = BigInt(row.discovery_block);
    return block < minimum ? block : minimum;
  }, toBlock);
  const byPool = new Map(rows.map((row) => [row.pool_id, []]));
  let cursor = first;
  while (cursor <= toBlock) {
    const end = cursor + BigInt(rangeSize) - 1n < toBlock
      ? cursor + BigInt(rangeSize) - 1n : toBlock;
    const leaves = await fetchLogs(client, {
      address: CANONICAL_CONTRACTS.UNISWAP_V4_POOL_MANAGER,
      topics: [v4.TOPICS.modifyLiquidity, rows.map((row) => row.pool_id)],
    }, cursor, end, 1n, { parallelSplits: true });
    for (const log of leaves.flat().filter((entry) => entry?.removed !== true)) {
      const poolId = String(log.topics?.[1] || '').toLowerCase();
      const row = rows.find((item) => item.pool_id === poolId);
      if (!row) continue;
      const event = v4.decodeModifyLiquidity(log, {
        tracked: true, poolId, marketKey: row.market_key,
        tokenAddress: row.token_address, quoteAddress: row.quote_address,
        tickSpacing: Number(row.tick_spacing),
      }, { poolManagerAddress: CANONICAL_CONTRACTS.UNISWAP_V4_POOL_MANAGER });
      byPool.get(poolId).push(event);
    }
    cursor = end + 1n;
    logger.log(JSON.stringify({ event: 'stock_pool_liquidity_audit_progress',
      nextBlock: cursor.toString(), toBlock: toBlock.toString(),
      events: [...byPool.values()].reduce((sum, events) => sum + events.length, 0) }));
  }
  return new Map([...byPool].map(([poolId, events]) => [poolId, {
    events: events.length,
    ranges: mergeRangeDeltas([], events.sort((left, right) => (
      BigInt(left.blockNumber) === BigInt(right.blockNumber)
        ? Number(BigInt(left.logIndex) - BigInt(right.logIndex))
        : Number(BigInt(left.blockNumber) - BigInt(right.blockNumber))
    ))),
  }]));
}

async function runAudit(input, deps = {}) {
  const database = deps.database || db;
  const logger = deps.logger || console;
  const archive = deps.archiveRpc || rpc(input.archiveRpcUrl, 'stock-liquidity-archive');
  const live = deps.liveRpc || rpc(input.liveRpcUrl, 'stock-liquidity-live');
  for (const [name, client] of [['archive', archive], ['live', live]]) {
    const chainId = BigInt(await request(client, `${name} chain id`, 'eth_chainId'));
    if (chainId !== CHAIN_ID) throw new Error(`${name} RPC is not Robinhood Chain`);
  }
  const rows = await candidates(database, input.tokenAddress);
  const [archiveHead, liveHead] = await Promise.all([
    request(archive, 'archive head', 'eth_blockNumber').then(BigInt),
    request(live, 'live head', 'eth_blockNumber').then(BigInt),
  ]);
  const anchorBlock = archiveHead < liveHead ? archiveHead : liveHead;
  const ranges = await scanRanges(archive, rows, anchorBlock, input.rangeSize, logger);
  const metadata = createErc20MetadataReader({ rpcClient: live });
  const tag = `0x${anchorBlock.toString(16)}`;
  const pools = [];
  let missing = rational(0n);
  for (const row of rows) {
    const reference = {
      market_key: row.ref_market_key, token_address: row.ref_token_address,
      quote_address: row.ref_quote_address, currency0: row.ref_currency0,
      currency1: row.ref_currency1,
    };
    const [tokenMeta, stockMeta, usdgMeta, refSlot, poolSlot, poolLiquidity] = await Promise.all([
      metadata.getMetadata(row.token_address, { blockTag: tag }),
      metadata.getMetadata(row.quote_address, { blockTag: tag }),
      metadata.getMetadata(CANONICAL_CONTRACTS.USDG, { blockTag: tag }),
      request(live, `${row.symbol} reference slot0`, 'eth_call', [
        { to: row.ref_pool_address, data: SLOT0_SELECTOR }, tag,
      ]),
      request(live, `${row.symbol} target slot0`, 'eth_call', [
        { to: CANONICAL_CONTRACTS.UNISWAP_V4_STATE_VIEW,
          data: bytes32Call(V4_SLOT0_SELECTOR, row.pool_id) }, tag,
      ]),
      request(live, `${row.symbol} target liquidity`, 'eth_call', [
        { to: CANONICAL_CONTRACTS.UNISWAP_V4_STATE_VIEW,
          data: bytes32Call(V4_LIQUIDITY_SELECTOR, row.pool_id) }, tag,
      ]),
    ]);
    for (const item of [tokenMeta, stockMeta, usdgMeta]) {
      if (!item.usable) throw new Error(`metadata unavailable for ${item.address}`);
    }
    const stockUsd = tokenUsd('uniswap-v3', word(refSlot, 0, 160, 'reference slot0'),
      reference, stockMeta.decimals, usdgMeta.decimals, '1');
    const sqrtPriceX96 = word(poolSlot, 0, 160, 'target slot0');
    const tokenPriceUsd = tokenUsd('uniswap-v4', sqrtPriceX96, row,
      tokenMeta.decimals, stockMeta.decimals, stockUsd);
    const reconstruction = ranges.get(row.pool_id) || { events: 0, ranges: [] };
    const poolRanges = reconstruction.ranges;
    const assessment = buildLiquidityAssessment({
      protocol: 'uniswap-v4',
      liquidityRaw: word(poolLiquidity, 0, 128, 'target liquidity').toString(),
      sqrtPriceX96: sqrtPriceX96.toString(), quoteIndex: quoteIndex(row),
      v4Ranges: poolRanges, tokenDecimals: tokenMeta.decimals,
      quoteDecimals: stockMeta.decimals, tokenUsdPrice: tokenPriceUsd,
      quoteUsdPrice: stockUsd,
    });
    const liquidity = parseDecimal(assessment.liquidityUsd || '0');
    missing = add(missing, liquidity);
    pools.push(Object.freeze({
      stockSymbol: row.symbol, poolId: row.pool_id, referencePool: row.ref_pool_address,
      modifyLiquidityEvents: reconstruction.events,
      activeRanges: poolRanges.length, stockUsd: formatDecimal(parseDecimal(stockUsd), 8),
      liquidityUsd: formatDecimal(liquidity, 2),
    }));
  }
  const knownResult = await database.query(
    `SELECT COALESCE(SUM(snapshot.liquidity_usd),0)::text AS total
       FROM robinhood_pool_registry registry
       JOIN robinhood_pool_liquidity_snapshots snapshot USING(chain,protocol,market_key)
      WHERE registry.chain='robinhood' AND registry.active=TRUE
        AND registry.token_address=$1`, [input.tokenAddress]
  );
  const known = parseDecimal(knownResult.rows[0].total);
  const projected = add(known, missing);
  const report = {
    mode: 'read-only', tokenAddress: input.tokenAddress, anchorBlock: anchorBlock.toString(),
    archiveHead: archiveHead.toString(), liveHead: liveHead.toString(), pools,
    knownLiquidityUsd: formatDecimal(known, 2),
    stockPoolLiquidityUsd: formatDecimal(missing, 2),
    projectedLiquidityUsd: formatDecimal(projected, 2),
  };
  if (input.expectedTotalUsd != null) {
    const expected = parseDecimal(input.expectedTotalUsd);
    report.expectedLiquidityUsd = formatDecimal(expected, 2);
    report.residualUsd = formatDecimal(add(expected, rational(-projected.numerator,
      projected.denominator)), 2);
  }
  return Object.freeze(report);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const input = options(argv, deps.env || process.env);
  try {
    const report = await runAudit(input, deps);
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (!deps.database) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void main().catch((error) => {
  console.error(error.message); process.exitCode = 1;
});

module.exports = { main, options, runAudit, __private: { add, quoteIndex, request, tokenUsd } };
