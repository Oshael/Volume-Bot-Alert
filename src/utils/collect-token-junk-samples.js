const fs = require('node:fs');
const path = require('node:path');

const dexscreener = require('../services/dexscreener');
const { isValidAddress } = require('../models/user-token');

const DEFAULT_INPUT_PATH = path.resolve(process.cwd(), 'data/token-junk-dataset.json');
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'data/token-junk-samples.json');
const DEFAULT_API_BASE = process.env.TOKEN_JUNK_API_BASE || 'https://api.trendscope.pro';
const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 20000;

function parseInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] || '').trim();
    if (!raw.startsWith('--')) {
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      args[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next != null && !String(next).startsWith('--')) {
      args[withoutPrefix] = String(next);
      index += 1;
      continue;
    }

    args[withoutPrefix] = 'true';
  }

  return args;
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Number(parsed.toFixed(digits));
}

function computeSampleStddev(values) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (numeric.length < 2) {
    return null;
  }

  const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  const variance = numeric.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (numeric.length - 1);
  return Math.sqrt(variance);
}

function computeRangePct(minValue, maxValue, averageValue) {
  const min = Number(minValue);
  const max = Number(maxValue);
  const average = Number(averageValue);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(average) || !(average > 0)) {
    return null;
  }
  return ((max - min) / average) * 100;
}

function computeDriftPct(firstValue, lastValue) {
  const first = Number(firstValue);
  const last = Number(lastValue);
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(first > 0)) {
    return null;
  }
  return (Math.abs(last - first) / first) * 100;
}

function buildSeriesStats(values, digits = 2) {
  const numeric = (Array.isArray(values) ? values : []).filter((value) => value != null);
  if (!numeric.length) {
    return { min: null, max: null, avg: null, stddev: null };
  }

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const avg = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;

  return {
    min: roundMetric(min, digits),
    max: roundMetric(max, digits),
    avg: roundMetric(avg, digits),
    stddev: roundMetric(computeSampleStddev(numeric), digits),
  };
}

function getLatestVolumeFields(snapshot) {
  return {
    latestVolume5m: toNumberOrNull(snapshot?.volume5m ?? snapshot?.vol5m),
    latestVolume1h: toNumberOrNull(snapshot?.volume1h ?? snapshot?.vol1h),
    latestVolume6h: toNumberOrNull(snapshot?.volume6h ?? snapshot?.vol6h),
    latestVolume24h: toNumberOrNull(snapshot?.volume24h ?? snapshot?.vol24h),
  };
}

function buildMarketSummaryFromSnapshots(snapshots) {
  const first = snapshots[0] || null;
  const last = snapshots[snapshots.length - 1] || null;
  const mcapValues = snapshots.map((snapshot) => toNumberOrNull(snapshot?.mcap)).filter((value) => value != null);
  const priceValues = snapshots.map((snapshot) => toNumberOrNull(snapshot?.price)).filter((value) => value != null);
  const mcapStats = buildSeriesStats(mcapValues);
  const priceStats = buildSeriesStats(priceValues, 6);
  const totalSampleCount = snapshots.reduce((sum, snapshot) => sum + (Number(snapshot?.sampleCount) || 0), 0);

  return {
    snapshotCount: snapshots.length,
    totalSampleCount,
    firstTs: first?.ts || null,
    lastTs: last?.ts || null,
    firstMcap: toNumberOrNull(first?.mcap),
    lastMcap: toNumberOrNull(last?.mcap),
    minMcap: mcapStats.min,
    maxMcap: mcapStats.max,
    avgMcap: mcapStats.avg,
    rangePct: roundMetric(computeRangePct(mcapStats.min, mcapStats.max, mcapStats.avg)),
    driftPct: roundMetric(computeDriftPct(first?.mcap, last?.mcap)),
    mcapStddev: mcapStats.stddev,
    firstPrice: toNumberOrNull(first?.price),
    lastPrice: toNumberOrNull(last?.price),
    minPrice: priceStats.min,
    maxPrice: priceStats.max,
    avgPrice: priceStats.avg,
    priceRangePct: roundMetric(computeRangePct(priceStats.min, priceStats.max, priceStats.avg)),
    priceStddev: priceStats.stddev,
    ...getLatestVolumeFields(last),
  };
}

function summarizeMarketHistory(payload = {}) {
  const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
  return buildMarketSummaryFromSnapshots(snapshots);
}

function getSnapshotTvl(snapshot) {
  return toNumberOrNull(snapshot?.totalTvl ?? snapshot?.total_tvl ?? snapshot?.tvl);
}

function buildMeteoraWindowSummary(first, last) {
  return {
    firstTs: first?.ts || null,
    lastTs: last?.ts || null,
  };
}

function buildMeteoraPoolSummary(summary) {
  return {
    poolAddress: summary?.poolAddress || null,
    poolCount: Number(summary?.poolCount) || 0,
    noPool: Boolean(summary?.noPool),
    lastCheckedAt: summary?.lastCheckedAt || null,
    lastSnapshotAt: summary?.lastSnapshotAt || null,
  };
}

function buildMeteoraChangeSummary(summary) {
  return {
    change1h: toNumberOrNull(summary?.change1h),
    change6h: toNumberOrNull(summary?.change6h),
    change24h: toNumberOrNull(summary?.change24h),
  };
}

function buildMeteoraSummaryFromSnapshots(snapshots, summary = {}) {
  const first = snapshots[0] || null;
  const last = snapshots[snapshots.length - 1] || null;
  const tvlValues = snapshots.map((snapshot) => getSnapshotTvl(snapshot)).filter((value) => value != null);
  const tvlStats = buildSeriesStats(tvlValues);

  return {
    snapshotCount: snapshots.length,
    ...buildMeteoraWindowSummary(first, last),
    latestTvl: roundMetric(toNumberOrNull(summary?.tvl ?? getSnapshotTvl(last))),
    minTvl: tvlStats.min,
    maxTvl: tvlStats.max,
    avgTvl: tvlStats.avg,
    rangePct: roundMetric(computeRangePct(tvlStats.min, tvlStats.max, tvlStats.avg)),
    tvlStddev: tvlStats.stddev,
    ...buildMeteoraPoolSummary(summary),
    ...buildMeteoraChangeSummary(summary),
  };
}

function summarizeMeteoraPayload(payload = {}) {
  const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
  return buildMeteoraSummaryFromSnapshots(snapshots, payload.summary || {});
}

function buildEmptyDexSummary(pairCount = 0) {
  return {
    pairCount,
    pairAddress: null,
    dexId: null,
    url: null,
    marketCap: null,
    fdv: null,
    liquidityUsd: null,
    priceUsd: null,
    pairCreatedAt: null,
    volume5m: null,
    volume1h: null,
    volume6h: null,
    volume24h: null,
    txns5mBuys: null,
    txns5mSells: null,
    txns1hBuys: null,
    txns1hSells: null,
    txns24hBuys: null,
    txns24hSells: null,
    priceChange5m: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
    symbol: null,
    name: null,
    imageUrl: null,
  };
}

function buildDexTxnShortWindowSummary(bestPair) {
  return {
    txns5mBuys: toNumberOrNull(bestPair?.txns?.m5?.buys),
    txns5mSells: toNumberOrNull(bestPair?.txns?.m5?.sells),
    txns1hBuys: toNumberOrNull(bestPair?.txns?.h1?.buys),
    txns1hSells: toNumberOrNull(bestPair?.txns?.h1?.sells),
  };
}

function buildDexTxnLongWindowSummary(bestPair) {
  return {
    txns24hBuys: toNumberOrNull(bestPair?.txns?.h24?.buys),
    txns24hSells: toNumberOrNull(bestPair?.txns?.h24?.sells),
  };
}

function buildDexPriceChangeSummary(bestPair) {
  return {
    priceChange5m: toNumberOrNull(bestPair?.priceChange?.m5),
    priceChange1h: toNumberOrNull(bestPair?.priceChange?.h1),
    priceChange6h: toNumberOrNull(bestPair?.priceChange?.h6),
    priceChange24h: toNumberOrNull(bestPair?.priceChange?.h24),
  };
}

function buildDexBaseSummary(bestPair) {
  return {
    pairAddress: bestPair.pairAddress ?? null,
    dexId: bestPair.dexId ?? null,
    url: bestPair.url ?? null,
    marketCap: toNumberOrNull(bestPair.marketCap),
    fdv: toNumberOrNull(bestPair.fdv),
    liquidityUsd: toNumberOrNull(bestPair?.liquidity?.usd),
    priceUsd: toNumberOrNull(bestPair.priceUsd),
    pairCreatedAt: toNumberOrNull(bestPair.pairCreatedAt),
  };
}

function buildDexVolumeSummary(bestPair) {
  return {
    volume5m: toNumberOrNull(bestPair?.volume?.m5),
    volume1h: toNumberOrNull(bestPair?.volume?.h1),
    volume6h: toNumberOrNull(bestPair?.volume?.h6),
    volume24h: toNumberOrNull(bestPair?.volume?.h24),
  };
}

function buildDexTokenSummary(bestPair) {
  return {
    symbol: bestPair?.baseToken?.symbol ?? null,
    name: bestPair?.baseToken?.name ?? null,
    imageUrl: bestPair?.info?.imageUrl ?? null,
  };
}

function normalizeDexPair(bestPair, rawData = null) {
  const pairCount = Array.isArray(rawData?.pairs) ? rawData.pairs.length : (bestPair ? 1 : 0);
  if (!bestPair) {
    return buildEmptyDexSummary(pairCount);
  }

  return {
    ...buildEmptyDexSummary(pairCount),
    ...buildDexBaseSummary(bestPair),
    ...buildDexVolumeSummary(bestPair),
    ...buildDexTxnShortWindowSummary(bestPair),
    ...buildDexTxnLongWindowSummary(bestPair),
    ...buildDexPriceChangeSummary(bestPair),
    ...buildDexTokenSummary(bestPair),
  };
}

function buildHeaders(options = {}) {
  const headers = {
    accept: 'application/json',
  };

  const token = String(options.token || '').trim();
  const cookie = String(options.cookie || '').trim();

  if (token) {
    headers.authorization = `Bearer ${token}`;
  } else if (cookie) {
    headers.cookie = cookie;
  }

  return headers;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(options),
    signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS),
  });

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error(
      typeof body === 'object' && body?.error
        ? body.error
        : `Request failed with status ${response.status}`
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function buildApiUrl(apiBase, pathname, query = {}) {
  const url = new URL(pathname, `${String(apiBase || '').replace(/\/+$/, '')}/`);
  Object.entries(query).forEach(([key, value]) => {
    if (value == null || value === '') {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function resolveCollectorRequestOptions(options = {}) {
  return {
    historyDays: parseInteger(options.historyDays, DEFAULT_HISTORY_DAYS, { min: 1, max: 30 }),
    historyLimit: parseInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, { min: 1, max: 1000 }),
    apiOptions: {
      token: options.token,
      cookie: options.cookie,
      timeoutMs: options.timeoutMs,
    },
  };
}

function getSettledValue(result, fallbackMessage) {
  if (result.status === 'fulfilled') {
    return result.value;
  }
  return {
    error: result.reason?.message || fallbackMessage,
  };
}

function buildCollectedSection(payload, summaryBuilder) {
  return {
    ok: !payload.error,
    error: payload.error || null,
    count: Number(payload.count) || 0,
    summary: payload.error ? null : summaryBuilder(payload),
    payload: payload.error ? null : payload,
  };
}

function buildDexSection(result) {
  const dexData = result.status === 'fulfilled' ? result.value : null;
  const bestPair = dexData ? dexscreener.getBestPair(dexData, 'solana') : null;

  return {
    ok: result.status === 'fulfilled',
    error: result.status === 'fulfilled'
      ? null
      : (result.reason?.message || 'dexscreener collection failed'),
    summary: normalizeDexPair(bestPair, dexData),
    payload: dexData,
  };
}

async function collectSingleEntry(entry, options = {}) {
  const address = String(entry?.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error(`Invalid token address in dataset: ${address}`);
  }

  const { apiOptions, historyDays, historyLimit } = resolveCollectorRequestOptions(options);
  const marketHistoryUrl = buildApiUrl(options.apiBase, `/api/catalog/history/${address}`, {
    days: historyDays,
    limit: historyLimit,
  });
  const meteoraHistoryUrl = buildApiUrl(options.apiBase, `/api/catalog/meteora/${address}/history`, {
    days: historyDays,
    limit: historyLimit,
  });

  const [marketHistoryResult, meteoraResult, dexResult] = await Promise.allSettled([
    fetchJson(marketHistoryUrl, apiOptions),
    fetchJson(meteoraHistoryUrl, apiOptions),
    dexscreener.getTokenPairs(address, { chain: 'solana' }),
  ]);

  const marketHistory = getSettledValue(marketHistoryResult, 'market history collection failed');
  const meteora = getSettledValue(meteoraResult, 'meteora collection failed');

  return {
    address,
    label: entry.label,
    confidence: entry.confidence || null,
    reason: entry.reason,
    notes: entry.notes || null,
    collectedAt: new Date().toISOString(),
    collection: {
      marketHistory: buildCollectedSection(marketHistory, summarizeMarketHistory),
      meteora: buildCollectedSection(meteora, summarizeMeteoraPayload),
      dexscreener: buildDexSection(dexResult),
    },
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const safeConcurrency = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, items.length) }, () => worker()));
  return results;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveRunOptions(options = {}) {
  return {
    inputPath: path.resolve(options.inputPath || DEFAULT_INPUT_PATH),
    outputPath: path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH),
    apiBase: String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
    token: options.token,
    cookie: options.cookie,
    historyDays: parseInteger(options.historyDays, DEFAULT_HISTORY_DAYS, { min: 1, max: 30 }),
    historyLimit: parseInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, { min: 1, max: 1000 }),
    concurrency: parseInteger(options.concurrency, DEFAULT_CONCURRENCY, { min: 1, max: 10 }),
    timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
  };
}

async function runCollector(options = {}) {
  const resolved = resolveRunOptions(options);
  const dataset = readJsonFile(resolved.inputPath);
  const entries = Array.isArray(dataset?.entries) ? dataset.entries : [];

  if (!String(resolved.token || '').trim() && !String(resolved.cookie || '').trim()) {
    throw new Error('TOKEN_JUNK_API_TOKEN or TOKEN_JUNK_API_COOKIE is required for read-only API collection');
  }

  const collectedEntries = await mapWithConcurrency(
    entries,
    resolved.concurrency,
    (entry) => collectSingleEntry(entry, resolved)
  );

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      inputPath: resolved.inputPath,
      apiBase: resolved.apiBase,
      historyDays: resolved.historyDays,
      historyLimit: resolved.historyLimit,
      concurrency: resolved.concurrency,
      totalEntries: collectedEntries.length,
      sourceMeta: dataset?.meta || null,
    },
    entries: collectedEntries,
  };

  writeJsonFile(resolved.outputPath, output);
  return output;
}

async function main() {
  const args = parseArgs();
  const output = await runCollector({
    inputPath: args.input,
    outputPath: args.output,
    apiBase: args['api-base'] || DEFAULT_API_BASE,
    token: args.token || process.env.TOKEN_JUNK_API_TOKEN || '',
    cookie: args.cookie || process.env.TOKEN_JUNK_API_COOKIE || '',
    historyDays: args.days || process.env.TOKEN_JUNK_HISTORY_DAYS || DEFAULT_HISTORY_DAYS,
    historyLimit: args.limit || process.env.TOKEN_JUNK_HISTORY_LIMIT || DEFAULT_HISTORY_LIMIT,
    concurrency: args.concurrency || process.env.TOKEN_JUNK_CONCURRENCY || DEFAULT_CONCURRENCY,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  console.log(
    `[token-junk-collector] wrote ${output.entries.length} entries to ${path.resolve(args.output || DEFAULT_OUTPUT_PATH)}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[token-junk-collector] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildApiUrl,
  buildHeaders,
  collectSingleEntry,
  computeDriftPct,
  computeRangePct,
  computeSampleStddev,
  normalizeDexPair,
  parseArgs,
  runCollector,
  summarizeMarketHistory,
  summarizeMeteoraPayload,
};
