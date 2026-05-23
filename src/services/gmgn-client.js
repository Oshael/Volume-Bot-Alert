const { execFile } = require('node:child_process');
const { isValidAddress } = require('../models/user-token');

const DEFAULT_CLI_BIN = 'gmgn-cli';
const DEFAULT_CHAIN = 'sol';
const DEFAULT_INTERVAL = '5m';
const DEFAULT_LIMIT = 30;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RISK_LOOKUP_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_RISK_LOOKUP_CACHE_MAX_ENTRIES = 1000;
const VALID_CHAINS = new Set(['sol', 'bsc', 'base', 'eth']);
const VALID_INTERVALS = new Set(['1m', '5m', '1h', '6h', '24h']);

class GmgnCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GmgnCliError';
    this.code = details.code || 'GMGN_CLI_ERROR';
    this.exitCode = details.exitCode;
    this.stderr = details.stderr || '';
    this.stdout = details.stdout || '';
  }
}

class GmgnRateLimitError extends GmgnCliError {
  constructor(message, details = {}) {
    super(message, { ...details, code: 'GMGN_RATE_LIMIT' });
    this.name = 'GmgnRateLimitError';
    this.resetAt = details.resetAt || null;
  }
}

function defaultExecFileImpl(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function createRiskLookupCache(options = {}) {
  const ttlMs = parseNonNegativeInteger(options.ttlMs, DEFAULT_RISK_LOOKUP_CACHE_TTL_MS);
  const maxEntries = parsePositiveInteger(options.maxEntries, DEFAULT_RISK_LOOKUP_CACHE_MAX_ENTRIES);
  const now = options.now || (() => Date.now());
  const entries = new Map();
  const stats = {
    hits: 0,
    misses: 0,
    writes: 0,
    evictions: 0,
    expired: 0,
    clears: 0,
  };

  function pruneExpired(nowMs = now()) {
    for (const [key, entry] of entries.entries()) {
      if (!entry || entry.expiresAt <= nowMs) {
        entries.delete(key);
        stats.expired += 1;
      }
    }
  }

  function enforceLimit() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      entries.delete(oldestKey);
      stats.evictions += 1;
    }
  }

  function get(key) {
    if (ttlMs <= 0) {
      stats.misses += 1;
      return undefined;
    }
    const nowMs = now();
    const entry = entries.get(key);
    if (!entry || entry.expiresAt <= nowMs) {
      entries.delete(key);
      stats.misses += 1;
      if (entry) {
        stats.expired += 1;
      }
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    stats.hits += 1;
    return entry.value;
  }

  function set(key, value) {
    if (ttlMs <= 0) {
      return value;
    }
    pruneExpired();
    entries.set(key, {
      value,
      expiresAt: now() + ttlMs,
    });
    stats.writes += 1;
    enforceLimit();
    return value;
  }

  function clear() {
    entries.clear();
    stats.clears += 1;
  }

  function getStatus() {
    pruneExpired();
    return {
      enabled: ttlMs > 0,
      ttlMs,
      maxEntries,
      entries: entries.size,
      ...stats,
    };
  }

  return {
    clear,
    get,
    getStatus,
    set,
    size: () => entries.size,
  };
}

const defaultRiskLookupCache = createRiskLookupCache({
  ttlMs: parseNonNegativeInteger(process.env.GMGN_RISK_LOOKUP_CACHE_TTL_MS, DEFAULT_RISK_LOOKUP_CACHE_TTL_MS),
  maxEntries: parsePositiveInteger(process.env.GMGN_RISK_LOOKUP_CACHE_MAX_ENTRIES, DEFAULT_RISK_LOOKUP_CACHE_MAX_ENTRIES),
});

function normalizeChain(value) {
  const normalized = String(value || DEFAULT_CHAIN).trim().toLowerCase();
  return VALID_CHAINS.has(normalized) ? normalized : DEFAULT_CHAIN;
}

function normalizeInterval(value) {
  const normalized = String(value || DEFAULT_INTERVAL).trim().toLowerCase();
  return VALID_INTERVALS.has(normalized) ? normalized : DEFAULT_INTERVAL;
}

function normalizeLimit(value) {
  return Math.min(100, parsePositiveInteger(value, DEFAULT_LIMIT));
}

function resolveClientOptions(options = {}) {
  return {
    apiKey: String(options.apiKey || process.env.GMGN_API_KEY || '').trim(),
    cliBin: String(options.cliBin || process.env.GMGN_CLI_BIN || DEFAULT_CLI_BIN).trim() || DEFAULT_CLI_BIN,
    timeoutMs: parsePositiveInteger(options.timeoutMs || process.env.GMGN_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    execFileImpl: options.execFileImpl || defaultExecFileImpl,
    riskLookupCache: options.riskLookupCache || defaultRiskLookupCache,
  };
}

function buildTrendingArgs(options = {}) {
  return [
    'market',
    'trending',
    '--chain',
    normalizeChain(options.chain),
    '--interval',
    normalizeInterval(options.interval),
    '--order-by',
    String(options.orderBy || 'volume').trim() || 'volume',
    '--direction',
    String(options.direction || 'desc').trim() || 'desc',
    '--limit',
    String(normalizeLimit(options.limit)),
    '--raw',
  ];
}

function buildTokenSecurityArgs(options = {}) {
  return [
    'token',
    'security',
    '--chain',
    normalizeChain(options.chain),
    '--address',
    String(options.address || '').trim(),
    '--raw',
  ];
}

function buildTokenInfoArgs(options = {}) {
  return [
    'token',
    'info',
    '--chain',
    normalizeChain(options.chain),
    '--address',
    String(options.address || '').trim(),
    '--raw',
  ];
}

function buildMarketKlineArgs(options = {}) {
  return [
    'market',
    'kline',
    '--chain',
    normalizeChain(options.chain),
    '--address',
    String(options.address || '').trim(),
    '--resolution',
    String(options.resolution || '1m').trim() || '1m',
    '--from',
    String(options.from),
    '--to',
    String(options.to),
    '--raw',
  ];
}

function toFiniteNumber(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function readFirst(value, paths) {
  for (const path of paths) {
    const found = readPath(value, Array.isArray(path) ? path : [path]);
    if (found != null && found !== '') {
      return found;
    }
  }
  return undefined;
}

function readTrimmedString(value, paths) {
  const text = String(readFirst(value, paths) ?? '').trim();
  return text || null;
}

function readNumber(value, paths) {
  return toFiniteNumber(readFirst(value, paths));
}

function collectRankRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = [
    ['data', 'rank'],
    ['data', 'items'],
    ['data', 'tokens'],
    ['data', 'list'],
    ['rank'],
    ['items'],
    ['tokens'],
    ['list'],
    ['result', 'rank'],
    ['result', 'items'],
  ];

  for (const path of candidates) {
    const rows = readPath(payload, path);
    if (Array.isArray(rows)) {
      return rows;
    }
  }
  return [];
}

function normalizeTimestamp(value) {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) {
    return null;
  }
  return parsed > 100000000000 ? new Date(parsed).toISOString() : new Date(parsed * 1000).toISOString();
}

function normalizeTrendingToken(row, context = {}) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const address = readTrimmedString(row, ['address', 'token_address', 'tokenAddress', 'mint', ['baseToken', 'address']]);
  if (!isValidAddress(address)) {
    return null;
  }

  const interval = normalizeInterval(context.interval || row.interval);
  const intervalVolume = readNumber(row, ['volume', 'volume_usd', 'volumeUsd']);
  const normalized = {
    address,
    chain: normalizeChain(readTrimmedString(row, ['chain']) || context.chain),
    symbol: readTrimmedString(row, ['symbol', ['baseToken', 'symbol']]),
    name: readTrimmedString(row, ['name', ['baseToken', 'name']]),
    imageUrl: readTrimmedString(row, ['logo', 'imageUrl', 'logoUrl', 'icon', ['info', 'imageUrl']]),
    pairAddress: readTrimmedString(row, ['pairAddress', 'poolAddress', 'pool_address']),
    pairUrl: readTrimmedString(row, ['pairUrl', 'url']),
    mcap: readNumber(row, ['market_cap', 'marketCap', 'mcap', 'fdv']),
    price: readNumber(row, ['price', 'priceUsd', 'price_usd']),
    liquidityUsd: readNumber(row, ['liquidity', 'liquidityUsd', 'liquidity_usd']),
    priceChange1m: readNumber(row, ['price_change_percent1m', 'priceChange1m']),
    priceChange5m: readNumber(row, ['price_change_percent5m', 'priceChange5m']),
    priceChange1h: readNumber(row, ['price_change_percent1h', 'priceChange1h']),
    priceChange6h: readNumber(row, ['price_change_percent6h', 'priceChange6h']),
    priceChange24h: readNumber(row, ['price_change_percent24h', 'priceChange24h']),
    tokenCreatedAt: normalizeTimestamp(readFirst(row, ['creation_timestamp', 'created_at', 'open_timestamp'])),
    gmgnInterval: interval,
    gmgnRank: readNumber(row, ['rank']) ?? context.rank ?? null,
    source: 'gmgn',
    raw: row,
  };

  assignIntervalVolume(normalized, interval, intervalVolume);
  return normalized;
}

function normalizeRate(value) {
  const parsed = toFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  if (parsed > 1 && parsed <= 100) {
    return parsed / 100;
  }
  return parsed;
}

function normalizeBooleanish(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value == null || value === '') {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function normalizeTokenSecurityPayload(payload, context = {}) {
  const row = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!row || typeof row !== 'object') {
    return null;
  }

  const address = readTrimmedString(row, ['address', 'token_address', 'tokenAddress']) || context.address;
  if (!isValidAddress(address)) {
    return null;
  }

  return {
    address,
    chain: normalizeChain(readTrimmedString(row, ['chain']) || context.chain),
    top10HolderRate: normalizeRate(readFirst(row, [
      'top_10_holder_rate',
      'top10_holder_rate',
      'top10HolderRate',
      'top_10_pct',
      'top10Pct',
    ])),
    canSell: readNumber(row, ['can_sell', 'canSell']),
    canNotSell: readNumber(row, ['can_not_sell', 'canNotSell']),
    hideRisk: normalizeBooleanish(readFirst(row, ['hide_risk', 'hideRisk'])),
    renouncedFreezeAccount: normalizeBooleanish(readFirst(row, ['renounced_freeze_account', 'renouncedFreezeAccount'])),
    renouncedMint: normalizeBooleanish(readFirst(row, ['renounced_mint', 'renouncedMint'])),
    isHoneypot: normalizeBooleanish(readFirst(row, ['is_honeypot', 'honeypot', 'isHoneypot'])),
    isBlacklist: normalizeBooleanish(readFirst(row, ['is_blacklist', 'blacklist', 'isBlacklist'])),
    buyTax: readNumber(row, ['buy_tax', 'buyTax']),
    sellTax: readNumber(row, ['sell_tax', 'sellTax']),
    flags: Array.isArray(row.flags) ? row.flags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    raw: row,
  };
}

function computeMarketCapFromInfo(row) {
  const direct = readNumber(row, ['usd_market_cap', 'market_cap', 'marketCap', 'mcap', 'fdv']);
  if (direct != null) {
    return direct;
  }

  const price = readNumber(row, [['price', 'price'], 'priceUsd', 'price_usd', 'price']);
  const supply = readNumber(row, ['circulating_supply', 'circulatingSupply', 'total_supply', 'totalSupply']);
  return price != null && supply != null ? price * supply : null;
}

function computePriceChangePct(current, previous) {
  const currentPrice = toFiniteNumber(current);
  const previousPrice = toFiniteNumber(previous);
  if (!(currentPrice > 0) || !(previousPrice > 0)) {
    return null;
  }
  return ((currentPrice - previousPrice) / previousPrice) * 100;
}

function normalizeTokenInfoPayload(payload, context = {}) {
  const row = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!row || typeof row !== 'object') {
    return null;
  }

  const address = readTrimmedString(row, ['address', 'token_address', 'tokenAddress']) || context.address;
  if (!isValidAddress(address)) {
    return null;
  }

  const price = readNumber(row, [['price', 'price'], 'priceUsd', 'price_usd', 'price']);
  const price1h = readNumber(row, [['price', 'price_1h'], 'price_1h']);
  const price6h = readNumber(row, [['price', 'price_6h'], 'price_6h']);
  const price24h = readNumber(row, [['price', 'price_24h'], 'price_24h']);

  return {
    address,
    chain: normalizeChain(readTrimmedString(row, ['chain']) || context.chain),
    symbol: readTrimmedString(row, ['symbol']),
    name: readTrimmedString(row, ['name']),
    imageUrl: readTrimmedString(row, ['logo', 'imageUrl', 'logoUrl', 'icon']),
    pairAddress: readTrimmedString(row, ['biggest_pool_address', ['pool', 'pool_address'], 'pairAddress', 'poolAddress', 'pool_address']),
    pairUrl: readTrimmedString(row, [['link', 'gmgn'], 'pairUrl', 'url']),
    holderCount: readNumber(row, ['holder_count', 'holderCount', ['stat', 'holder_count']]),
    marketCap: computeMarketCapFromInfo(row),
    liquidityUsd: readNumber(row, ['liquidity', 'liquidityUsd', 'liquidity_usd', ['pool', 'liquidity']]),
    price,
    vol1m: readNumber(row, [['price', 'volume_1m'], 'volume_1m']),
    vol5m: readNumber(row, [['price', 'volume_5m'], 'volume_5m']),
    vol1h: readNumber(row, [['price', 'volume_1h'], 'volume_1h']),
    vol6h: readNumber(row, [['price', 'volume_6h'], 'volume_6h']),
    vol24h: readNumber(row, [['price', 'volume_24h'], 'volume_24h']),
    priceChange1h: computePriceChangePct(price, price1h),
    priceChange6h: computePriceChangePct(price, price6h),
    priceChange24h: computePriceChangePct(price, price24h),
    tokenCreatedAt: normalizeTimestamp(readFirst(row, ['creation_timestamp', 'created_at', 'open_timestamp'])),
    top10HolderRate: normalizeRate(readFirst(row, [
      'top_10_holder_rate',
      ['stat', 'top_10_holder_rate'],
      ['dev', 'top_10_holder_rate'],
    ])),
    topBundlerTraderRate: normalizeRate(readFirst(row, [['stat', 'top_bundler_trader_percentage']])),
    bundlerWalletCount: readNumber(row, [['wallet_tags_stat', 'bundler_wallets']]),
    botDegenRate: normalizeRate(readFirst(row, [['stat', 'bot_degen_rate']])),
    freshWalletRate: normalizeRate(readFirst(row, [['stat', 'fresh_wallet_rate']])),
    launchpad: readTrimmedString(row, ['launchpad']),
    launchpadPlatform: readTrimmedString(row, ['launchpad_platform', 'launchpadPlatform']),
    launchpadStatus: readNumber(row, ['launchpad_status']),
    launchpadProgress: readNumber(row, ['launchpad_progress', 'progress']),
    openTimestamp: normalizeTimestamp(readFirst(row, ['open_timestamp', 'openTimestamp'])),
    migratedTimestamp: normalizeTimestamp(readFirst(row, ['migrated_timestamp', 'migratedTimestamp'])),
    migratedPool: readTrimmedString(row, ['migrated_pool', 'migratedPool']),
    raw: row,
  };
}

function collectKlineRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const candidates = [
    ['data'],
    ['list'],
    ['items'],
    ['result'],
    ['result', 'list'],
    ['result', 'items'],
  ];
  for (const path of candidates) {
    const rows = readPath(payload, path);
    if (Array.isArray(rows)) {
      return rows;
    }
  }
  return [];
}

function normalizeKlineTimestamp(value) {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) {
    return null;
  }
  return parsed > 100000000000 ? Math.trunc(parsed) : Math.trunc(parsed * 1000);
}

function normalizeKlinePayload(payload) {
  return collectKlineRows(payload)
    .map((row) => ({
      timestampMs: normalizeKlineTimestamp(readFirst(row, ['time', 'timestamp', 't', 'open_time'])),
      open: readNumber(row, ['open', 'o']),
      high: readNumber(row, ['high', 'h']),
      low: readNumber(row, ['low', 'l']),
      close: readNumber(row, ['close', 'c']),
      volume: readNumber(row, ['volume', 'v', 'volume_usd', 'volumeUsd']),
    }))
    .filter((row) => row.timestampMs != null && row.open != null && row.close != null)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}



function assignIntervalVolume(target, interval, volume) {
  const keyByInterval = {
    '1m': 'vol1m',
    '5m': 'vol5m',
    '1h': 'vol1h',
    '6h': 'vol6h',
    '24h': 'vol24h',
  };
  const key = keyByInterval[normalizeInterval(interval)];
  target.vol1m = key === 'vol1m' ? volume : null;
  target.vol5m = key === 'vol5m' ? volume : null;
  target.vol1h = key === 'vol1h' ? volume : null;
  target.vol6h = key === 'vol6h' ? volume : null;
  target.vol24h = key === 'vol24h' ? volume : null;
}

function normalizeTrendingPayload(payload, context = {}) {
  return collectRankRows(payload)
    .map((row, index) => normalizeTrendingToken(row, { ...context, rank: index + 1 }))
    .filter(Boolean);
}

function extractJsonText(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return '';
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return text;
  }

  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function parseCliJson(stdout) {
  const jsonText = extractJsonText(stdout);
  if (!jsonText) {
    throw new GmgnCliError('GMGN CLI returned empty output', { code: 'GMGN_EMPTY_OUTPUT', stdout });
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new GmgnCliError('GMGN CLI returned invalid JSON', {
      code: 'GMGN_INVALID_JSON',
      stdout,
      stderr: error.message,
    });
  }
}

function extractResetAt(text) {
  const match = String(text || '').match(/"reset_at"\s*:\s*(\d+)|reset_at[=:]\s*(\d+)/i);
  const parsed = match ? Number(match[1] || match[2]) : null;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isRateLimitError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
  return /429|rate[_ -]?limit|too many requests|RATE_LIMIT_(?:EXCEEDED|BANNED)/i.test(text);
}

function createGmgnClient(options = {}) {
  const resolved = resolveClientOptions(options);

  function buildCacheKey(kind, args) {
    return JSON.stringify({
      kind,
      cliBin: resolved.cliBin,
      apiKey: resolved.apiKey ? 'configured' : 'empty',
      args,
    });
  }

  async function runCachedCliJson(kind, args, requestOptions, normalize) {
    if (requestOptions.skipCache === true || requestOptions.cache === false) {
      return normalize(await runCliJson(args, requestOptions));
    }

    const cacheKey = buildCacheKey(kind, args);
    const cached = resolved.riskLookupCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const normalized = normalize(await runCliJson(args, requestOptions));
    return resolved.riskLookupCache.set(cacheKey, normalized);
  }

  async function runCliJson(args, requestOptions = {}) {
    const env = resolved.apiKey
      ? { ...process.env, GMGN_API_KEY: resolved.apiKey }
      : process.env;
    const { stdout } = await resolved.execFileImpl(resolved.cliBin, args, {
      env,
      timeout: requestOptions.timeoutMs || resolved.timeoutMs,
      maxBuffer: 1024 * 1024 * 10,
    });
    return parseCliJson(stdout);
  }

  async function fetchTrending(requestOptions = {}) {
    const chain = normalizeChain(requestOptions.chain);
    const interval = normalizeInterval(requestOptions.interval);
    const limit = normalizeLimit(requestOptions.limit);
    const args = buildTrendingArgs({ ...requestOptions, chain, interval, limit });

    try {
      return normalizeTrendingPayload(await runCliJson(args, requestOptions), { chain, interval });
    } catch (error) {
      if (error instanceof GmgnCliError) {
        throw error;
      }
      const details = {
        exitCode: error?.code,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        resetAt: extractResetAt(`${error?.stderr || ''}\n${error?.stdout || ''}`),
      };
      if (isRateLimitError(error)) {
        throw new GmgnRateLimitError('GMGN CLI rate limit reached', details);
      }
      throw new GmgnCliError(error?.message || 'GMGN CLI request failed', details);
    }
  }

  async function fetchTokenSecurity(requestOptions = {}) {
    const chain = normalizeChain(requestOptions.chain);
    const address = String(requestOptions.address || '').trim();
    if (!isValidAddress(address)) {
      throw new GmgnCliError('Invalid token address format', { code: 'GMGN_INVALID_ADDRESS' });
    }

    const args = buildTokenSecurityArgs({ ...requestOptions, chain, address });
    try {
      return runCachedCliJson('token-security', args, requestOptions, (payload) => (
        normalizeTokenSecurityPayload(payload, { chain, address })
      ));
    } catch (error) {
      if (error instanceof GmgnCliError) {
        throw error;
      }
      const details = {
        exitCode: error?.code,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        resetAt: extractResetAt(`${error?.stderr || ''}\n${error?.stdout || ''}`),
      };
      if (isRateLimitError(error)) {
        throw new GmgnRateLimitError('GMGN CLI rate limit reached', details);
      }
      throw new GmgnCliError(error?.message || 'GMGN CLI request failed', details);
    }
  }

  async function fetchTokenInfo(requestOptions = {}) {
    const chain = normalizeChain(requestOptions.chain);
    const address = String(requestOptions.address || '').trim();
    if (!isValidAddress(address)) {
      throw new GmgnCliError('Invalid token address format', { code: 'GMGN_INVALID_ADDRESS' });
    }

    const args = buildTokenInfoArgs({ ...requestOptions, chain, address });
    try {
      return runCachedCliJson('token-info', args, requestOptions, (payload) => (
        normalizeTokenInfoPayload(payload, { chain, address })
      ));
    } catch (error) {
      if (error instanceof GmgnCliError) {
        throw error;
      }
      const details = {
        exitCode: error?.code,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        resetAt: extractResetAt(`${error?.stderr || ''}\n${error?.stdout || ''}`),
      };
      if (isRateLimitError(error)) {
        throw new GmgnRateLimitError('GMGN CLI rate limit reached', details);
      }
      throw new GmgnCliError(error?.message || 'GMGN CLI request failed', details);
    }
  }

  async function fetchMarketKline(requestOptions = {}) {
    const chain = normalizeChain(requestOptions.chain);
    const address = String(requestOptions.address || '').trim();
    if (!isValidAddress(address)) {
      throw new GmgnCliError('Invalid token address format', { code: 'GMGN_INVALID_ADDRESS' });
    }

    const args = buildMarketKlineArgs({ ...requestOptions, chain, address });
    try {
      return runCachedCliJson('market-kline', args, requestOptions, normalizeKlinePayload);
    } catch (error) {
      if (error instanceof GmgnCliError) {
        throw error;
      }
      const details = {
        exitCode: error?.code,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        resetAt: extractResetAt(`${error?.stderr || ''}\n${error?.stdout || ''}`),
      };
      if (isRateLimitError(error)) {
        throw new GmgnRateLimitError('GMGN CLI rate limit reached', details);
      }
      throw new GmgnCliError(error?.message || 'GMGN CLI request failed', details);
    }
  }

  return {
    fetchMarketKline,
    fetchTrending,
    fetchTokenInfo,
    fetchTokenSecurity,
  };
}

module.exports = {
  createGmgnClient,
  getStatus: () => ({
    riskLookupCache: defaultRiskLookupCache.getStatus(),
  }),
  GmgnCliError,
  GmgnRateLimitError,
  __private: {
    buildMarketKlineArgs,
    buildTokenInfoArgs,
    buildTokenSecurityArgs,
    createRiskLookupCache,
    collectKlineRows,
    buildTrendingArgs,
    collectRankRows,
    extractJsonText,
    normalizeChain,
    normalizeInterval,
    normalizeLimit,
    normalizeRate,
    normalizeKlinePayload,
    normalizeTokenInfoPayload,
    normalizeTokenSecurityPayload,
    normalizeTrendingPayload,
    normalizeTrendingToken,
    parseCliJson,
    resolveClientOptions,
    defaultRiskLookupCache,
  },
};
