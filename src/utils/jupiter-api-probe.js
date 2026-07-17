require('dotenv').config();

const db = require('../models/db');
const { isValidAddress } = require('../models/user-token');

const API_BASE = 'https://api.jup.ag';
const PRICE_BATCH_SIZE = 50;
const TOKEN_BATCH_SIZE = 100;
const DEFAULT_LIMIT = 50;
const KEYLESS_DELAY_MS = 2_200;
const KEYED_DELAY_MS = 1_100;

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function uniqueAddresses(addresses) {
  return [...new Set((addresses || [])
    .map((address) => String(address || '').trim())
    .filter((address) => isValidAddress(address) && !address.startsWith('0x')))];
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(apiKey) {
  return apiKey ? { 'x-api-key': apiKey } : {};
}

function buildPriceUrl(ids) {
  const url = new URL('/price/v3', API_BASE);
  url.searchParams.set('ids', ids.join(','));
  return url.toString();
}

function buildTokensUrl(ids) {
  const url = new URL('/tokens/v2/search', API_BASE);
  url.searchParams.set('query', ids.join(','));
  return url.toString();
}

function createEndpointUsage() {
  return {
    requests: 0,
    bytes: 0,
    latencyMs: 0,
    lastRateLimitCurrent: null,
    lastRateLimitRemaining: null,
    lastRateLimitReset: null,
    lastCreditsConsumed: null,
  };
}

function readHeader(headers, name) {
  return typeof headers?.get === 'function' ? headers.get(name) : null;
}

function updateEndpointUsage(usage, result) {
  usage.requests += 1;
  usage.bytes += result.bytes;
  usage.latencyMs += result.latencyMs;
  usage.lastRateLimitCurrent = result.headers['x-ratelimit-current'] || usage.lastRateLimitCurrent;
  usage.lastRateLimitRemaining = result.headers['x-ratelimit-remaining'] || usage.lastRateLimitRemaining;
  usage.lastRateLimitReset = result.headers['x-ratelimit-reset'] || usage.lastRateLimitReset;
  usage.lastCreditsConsumed = result.headers['x-credits-consumed'] || usage.lastCreditsConsumed;
}

function volumeTotal(stats = {}) {
  const buy = Number(stats.buyVolume);
  const sell = Number(stats.sellVolume);
  return (Number.isFinite(buy) ? buy : 0) + (Number.isFinite(sell) ? sell : 0);
}

function normalizePriceResults(requestedIds, body) {
  const byId = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return requestedIds.map((id) => {
    const item = byId[id] || null;
    return {
      id,
      found: Boolean(item),
      usdPrice: Number.isFinite(Number(item?.usdPrice)) ? Number(item.usdPrice) : null,
      blockId: Number.isFinite(Number(item?.blockId)) ? Number(item.blockId) : null,
      decimals: Number.isFinite(Number(item?.decimals)) ? Number(item.decimals) : null,
      priceChange24h: Number.isFinite(Number(item?.priceChange24h)) ? Number(item.priceChange24h) : null,
    };
  });
}

function normalizeTokenResults(body) {
  const items = Array.isArray(body) ? body : [];
  return items
    .filter((item) => isValidAddress(String(item?.id || '')))
    .map((item) => ({
      id: String(item.id),
      symbol: item.symbol || null,
      name: item.name || null,
      isVerified: Boolean(item.isVerified),
      organicScore: Number.isFinite(Number(item.organicScore)) ? Number(item.organicScore) : null,
      liquidity: Number.isFinite(Number(item.liquidity)) ? Number(item.liquidity) : null,
      mcap: Number.isFinite(Number(item.mcap)) ? Number(item.mcap) : null,
      usdPrice: Number.isFinite(Number(item.usdPrice)) ? Number(item.usdPrice) : null,
      priceBlockId: Number.isFinite(Number(item.priceBlockId)) ? Number(item.priceBlockId) : null,
      volume5m: volumeTotal(item.stats5m),
      volume1h: volumeTotal(item.stats1h),
      volume6h: volumeTotal(item.stats6h),
      volume24h: volumeTotal(item.stats24h),
      numTraders5m: Number.isFinite(Number(item.stats5m?.numTraders)) ? Number(item.stats5m.numTraders) : null,
      numTraders1h: Number.isFinite(Number(item.stats1h?.numTraders)) ? Number(item.stats1h.numTraders) : null,
      updatedAt: item.updatedAt || null,
      firstPoolCreatedAt: item.firstPool?.createdAt || null,
      isSus: item.audit?.isSus === true,
    }));
}

function summarizeProbe(addresses, priceRows, tokenRows, timings, usage = {}) {
  const tokenById = new Map(tokenRows.map((item) => [item.id, item]));
  const joined = priceRows.map((price) => ({
    ...price,
    token: tokenById.get(price.id) || null,
  }));
  const priced = joined.filter((item) => item.found).length;
  const withTokenInfo = joined.filter((item) => item.token).length;
  const withVolume5m = joined.filter((item) => Number(item.token?.volume5m) > 0).length;
  const withVolume1h = joined.filter((item) => Number(item.token?.volume1h) > 0).length;
  return {
    requested: addresses.length,
    priced,
    missingPrice: addresses.length - priced,
    tokenInfoFound: withTokenInfo,
    missingTokenInfo: addresses.length - withTokenInfo,
    withVolume5m,
    withVolume1h,
    priceLatencyMs: timings.priceLatencyMs,
    tokenLatencyMs: timings.tokenLatencyMs,
    usage,
    samples: joined.slice(0, 10).map((item) => ({
      id: item.id,
      symbol: item.token?.symbol || null,
      price: item.usdPrice,
      blockId: item.blockId,
      volume5m: item.token?.volume5m ?? null,
      volume1h: item.token?.volume1h ?? null,
      liquidity: item.token?.liquidity ?? null,
      isVerified: item.token?.isVerified ?? null,
      isSus: item.token?.isSus ?? null,
    })),
  };
}

async function fetchJson(url, options = {}) {
  const startedAt = Date.now();
  const response = await (options.fetchImpl || fetch)(url, {
    headers: buildHeaders(options.apiKey),
    signal: AbortSignal.timeout(options.timeoutMs || 10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Jupiter HTTP ${response.status}: ${text.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return {
    body: JSON.parse(text),
    latencyMs: Date.now() - startedAt,
    bytes: Buffer.byteLength(text, 'utf8'),
    headers: {
      'x-ratelimit-current': readHeader(response.headers, 'x-ratelimit-current'),
      'x-ratelimit-remaining': readHeader(response.headers, 'x-ratelimit-remaining'),
      'x-ratelimit-reset': readHeader(response.headers, 'x-ratelimit-reset'),
      'x-credits-consumed': readHeader(response.headers, 'x-credits-consumed'),
    },
  };
}

async function tableExists(tableName) {
  const { rows } = await db.query('SELECT to_regclass($1) AS name', [tableName]);
  return Boolean(rows[0]?.name);
}

async function loadProbeAddresses(limit = DEFAULT_LIMIT) {
  if (await tableExists('token_catalog')) {
    const { rows } = await db.query(
      `SELECT address
       FROM token_catalog
       WHERE chain = 'solana'
       ORDER BY
         CASE WHEN eligible_for_monitoring = TRUE THEN 0 ELSE 1 END,
         CASE COALESCE(monitor_priority, 'dormant')
           WHEN 'high' THEN 0
           WHEN 'normal' THEN 1
           WHEN 'low' THEN 2
           ELSE 3
         END,
         COALESCE(last_vol_1h, 0) DESC,
         last_seen_at DESC
       LIMIT $1`,
      [limit],
    );
    return uniqueAddresses(rows.map((row) => row.address));
  }

  if (await tableExists('user_tokens')) {
    const { rows } = await db.query(
      `SELECT DISTINCT address
       FROM user_tokens
       ORDER BY address ASC
       LIMIT $1`,
      [limit],
    );
    return uniqueAddresses(rows.map((row) => row.address));
  }

  return [];
}

async function fetchPriceBatches(addresses, options) {
  const rows = [];
  const usage = createEndpointUsage();
  let totalLatencyMs = 0;
  for (const ids of chunk(addresses, PRICE_BATCH_SIZE)) {
    const result = await fetchJson(buildPriceUrl(ids), options);
    updateEndpointUsage(usage, result);
    totalLatencyMs += result.latencyMs;
    rows.push(...normalizePriceResults(ids, result.body));
    if (options.delayMs > 0) await sleep(options.delayMs);
  }
  return { rows, latencyMs: totalLatencyMs, usage };
}

async function fetchTokenBatches(addresses, options) {
  const rows = [];
  const usage = createEndpointUsage();
  let totalLatencyMs = 0;
  for (const ids of chunk(addresses, TOKEN_BATCH_SIZE)) {
    const result = await fetchJson(buildTokensUrl(ids), options);
    updateEndpointUsage(usage, result);
    totalLatencyMs += result.latencyMs;
    rows.push(...normalizeTokenResults(result.body));
    if (options.delayMs > 0) await sleep(options.delayMs);
  }
  return { rows, latencyMs: totalLatencyMs, usage };
}

function readProbeOptions() {
  const apiKey = readEnv('JUPITER_API_KEY');
  const addresses = uniqueAddresses(readEnv('JUPITER_PROBE_ADDRESSES').split(','));
  return {
    apiKey,
    addresses,
    limit: positiveInteger(readEnv('JUPITER_PROBE_LIMIT'), DEFAULT_LIMIT),
    delayMs: positiveInteger(readEnv('JUPITER_PROBE_DELAY_MS'), apiKey ? KEYED_DELAY_MS : KEYLESS_DELAY_MS),
  };
}

async function runJupiterProbe(options = readProbeOptions()) {
  const addresses = options.addresses.length ? options.addresses : await loadProbeAddresses(options.limit);
  if (!addresses.length) {
    throw new Error('No Solana token addresses found. Set JUPITER_PROBE_ADDRESSES or seed token_catalog/user_tokens.');
  }

  console.log(`[JupiterProbe] addresses=${addresses.length} apiKey=${options.apiKey ? 'yes' : 'no'} delayMs=${options.delayMs}`);
  const price = await fetchPriceBatches(addresses, options);
  const tokens = await fetchTokenBatches(addresses, options);
  const summary = summarizeProbe(addresses, price.rows, tokens.rows, {
    priceLatencyMs: price.latencyMs,
    tokenLatencyMs: tokens.latencyMs,
  }, {
    price: price.usage,
    tokens: tokens.usage,
    totalRequests: price.usage.requests + tokens.usage.requests,
    totalBytes: price.usage.bytes + tokens.usage.bytes,
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  runJupiterProbe().then(async () => {
    await db.pool.end();
    process.exit(0);
  }).catch(async (error) => {
    console.error(`[JupiterProbe] failed=${error.message}`);
    try { await db.pool.end(); } catch (_) {}
    process.exit(1);
  });
}

module.exports = {
  PRICE_BATCH_SIZE,
  TOKEN_BATCH_SIZE,
  buildPriceUrl,
  buildTokensUrl,
  chunk,
  createEndpointUsage,
  normalizePriceResults,
  normalizeTokenResults,
  summarizeProbe,
  updateEndpointUsage,
  uniqueAddresses,
};
