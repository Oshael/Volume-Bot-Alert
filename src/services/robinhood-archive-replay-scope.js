const { createHash } = require('node:crypto');
const { ROBINHOOD_TOKENIZED_ASSETS, classifyTokenEligibility } = require('./robinhood-market-policy');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

const STOCKS = Object.values(ROBINHOOD_TOKENIZED_ASSETS);
const SWAPS = new Map([
  [v2.TOPICS.swap, 'uniswap-v2'], [v3.TOPICS.swap, 'uniswap-v3'],
  [v4.TOPICS.swap, 'uniswap-v4'],
]);

function protocols(target) {
  return target === 'stock-quote' ? [...SWAPS.values()] : ['uniswap-v3'];
}

function swapTopics(target) {
  return target === 'stock-quote' ? [...SWAPS.keys()] : [v3.TOPICS.swap];
}

function poolKey(protocol, address, poolId) {
  return `${protocol}:${String(address).toLowerCase()}${
    protocol === 'uniswap-v4' ? `:${String(poolId).toLowerCase()}` : ''
  }`;
}

function poolIndex(rows, target = 'v3', toBlock) {
  const index = new Map();
  for (const row of rows) {
    if (!protocols(target).includes(row.protocol)) continue;
    if (target === 'stock-quote' && (!STOCKS.includes(row.quote_address)
        || !classifyTokenEligibility(row.token_address).eligible
        || (toBlock != null && BigInt(row.discovery_block || 0) > BigInt(toBlock)))) continue;
    index.set(poolKey(row.protocol,
      row.protocol === 'uniswap-v4' ? row.origin_address : row.pool_address, row.pool_id), row);
  }
  return index;
}

function findPool(log, index) {
  const protocol = SWAPS.get(String(log?.topics?.[0] || '').toLowerCase());
  return index.get(poolKey(protocol, log?.address, log?.topics?.[1]));
}

function poolDigest(index) {
  const identities = [...index.values()].map((row) => [
    row.protocol, row.market_key, row.pool_address, row.pool_id, row.origin_address,
    row.token_address, row.quote_address, row.currency0, row.currency1,
    row.fee, row.tick_spacing, row.discovery_block,
    typeof row.metadata === 'string' ? JSON.parse(row.metadata).quoteIndex : row.metadata?.quoteIndex,
  ]).sort((left, right) => String(left[1]).localeCompare(String(right[1])));
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

async function anchorHash(rpcClient, toBlock) {
  const block = await rpcClient.request('eth_getBlockByNumber', [
    `0x${BigInt(toBlock).toString(16)}`, false,
  ]);
  if (block?.number == null || BigInt(block.number) !== BigInt(toBlock)
      || !/^0x[0-9a-f]{64}$/i.test(block.hash || '')) {
    throw new Error('Archive replay end block is unavailable or invalid');
  }
  return block.hash.toLowerCase();
}

function assertComplete(target, builds, expected) {
  if (target !== 'stock-quote') return;
  const failed = builds.flatMap((built) => built.failures || []);
  if (failed.length || builds.reduce((total, built) => total + built.entries.length, 0) !== expected) {
    throw new Error(`Stock archive range incomplete; checkpoint unchanged: ${
      failed[0]?.error?.message || 'enrichment lost a swap identity'
    }`);
  }
}

function repairedCount(target, committed) {
  return target === 'stock-quote' ? Number(committed.insertedObservations || 0) : committed.insertedLogs;
}

async function assertAnchor(target, rpcClient, options) {
  if (target === 'stock-quote' && await anchorHash(rpcClient, options.toBlock) !== options.anchorHash) {
    throw new Error('Archive replay end block changed; checkpoint unchanged');
  }
}

module.exports = {
  STOCKS, anchorHash, assertAnchor, assertComplete, findPool, poolDigest,
  poolIndex, protocols, repairedCount, swapTopics,
};
