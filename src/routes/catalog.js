const express = require('express');
const router = express.Router();
const config = require('../../config');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const { catalogReadLimiter, catalogWriteLimiter, pumpfunMetaLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenRiskReview = require('../models/token-risk-review');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketLateralizationRun = require('../models/token-market-lateralization-run');
const tokenMarketBidZoneRun = require('../models/token-market-bid-zone-run');
const tokenMeteoraState = require('../models/token-meteora-state');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const userToken = require('../models/user-token');
const dexscreener = require('../services/dexscreener');
const { isValidAddress } = require('../models/user-token');
const { logSecurityEvent } = require('../utils/security-events');
const { normalizeChain, normalizeText, sanitizeHttpUrl, sanitizeAssetUrl } = require('../utils/url-safety');
const { logTrace } = require('../utils/pump-migrate-trace');
const bidZoneWorker = require('../services/bid-zone-worker');

const MONITORED_MIN_MCAP = 30000;
const BID_ZONE_DEFAULT_OPTIONS = bidZoneWorker.DEFAULT_OPTIONS;
const TRANSIENT_RETRY_MS = 40000;
const PROMOTE_RETRY_MAX_ENTRIES = 2000;
const promoteRetryState = new Map();
const pumpfunMetaCache = new Map();
const pumpfunMetaInFlight = new Map();
const PUMPFUN_META_CACHE_LIMIT = 500;
const PUMPFUN_HOTLINK_BLOCKED_IMAGE_HOSTS = new Set([
  'metadata.j7tracker.io',
]);

function normalizeMinMcap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_MCAP;
}

function parseMeteoraBatchAddresses(value) {
  const raw = Array.isArray(value) ? value : [];
  const addresses = [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))];
  if (addresses.length === 0) {
    return { ok: false, error: 'addresses is required' };
  }
  if (addresses.length > 500) {
    return { ok: false, error: 'addresses must contain 500 items or fewer' };
  }

  for (const address of addresses) {
    if (!isValidAddress(address)) {
      return { ok: false, error: 'Invalid token address' };
    }
  }

  return { ok: true, addresses };
}

router.use(authenticate);
router.use(requireTrustedOrigin);

router.get('/eligible', catalogReadLimiter, async (req, res) => {
  try {
    const minMcap = normalizeMinMcap(req.query?.minMcap);
    const tokens = await tokenCatalog.listEligibleVisible(req.query?.limit, minMcap);
    res.json({
      tokens: tokens.map((item) => ({
        address: item.address,
        symbol: item.symbol || null,
        name: item.name || null,
        eligibleForMonitoring: Boolean(item.eligible_for_monitoring),
        mcap: item.last_mcap == null ? null : Number(item.last_mcap),
        lastSeenAt: item.last_seen_at || null,
        lastEvaluatedAt: item.last_evaluated_at || null,
      })),
      count: tokens.length,
      source: 'token_catalog',
      minMcap,
    });
  } catch (err) {
    console.error('GET /catalog/eligible error:', err.message);
    res.status(500).json({ error: 'Failed to load eligible catalog tokens' });
  }
});

router.post('/manual-track', catalogWriteLimiter, async (req, res) => {
  try {
    const address = String(req.body?.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    if (await adminBlockedToken.hasAddress(address)) {
      return res.status(403).json({ error: 'Token is permanently blocked by admin' });
    }

    await tokenCatalog.upsertToken({
      address,
      chain: 'solana',
      source: 'user-manual',
    });
    await tokenCatalog.scheduleImmediateEvaluation(address);

    res.status(201).json({
      message: 'Manual token scheduled for catalog tracking',
      tracked: { address },
    });
  } catch (err) {
    console.error('POST /catalog/manual-track error:', err.message);
    res.status(500).json({ error: 'Failed to schedule manual token tracking' });
  }
});

router.post('/admin-blocklist', catalogWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const address = String(req.body?.address || '').trim();
    const label = normalizeText(req.body?.label, 128);

    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    await adminBlockedToken.add({
      address,
      label,
      createdBy: req.user.id,
    });

    await tokenCatalog.upsertToken({
      address,
      chain: 'solana',
      source: 'admin-blocked',
      symbol: label,
      isActiveMonitorCandidate: false,
    });

    await tokenCatalog.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: label,
    });
    await tokenRiskReview.removeAutoReview(address);

    res.status(201).json({
      message: 'Token permanently blocked in backend catalog',
      blocked: { address, label },
    });
  } catch (err) {
    console.error('POST /catalog/admin-blocklist error:', err.message);
    res.status(500).json({ error: 'Failed to permanently block token' });
  }
});

router.delete('/admin-blocklist/:address', catalogWriteLimiter, requireAdmin, async (req, res) => {
  try {
    const address = String(req.params.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const removed = await adminBlockedToken.remove(address);
    if (!removed) {
      return res.status(404).json({ error: 'Token is not in the admin blocklist' });
    }

    await tokenCatalog.scheduleImmediateEvaluation(address).catch(() => null);

    res.json({ message: 'Token removed from admin blocklist', address });
  } catch (err) {
    console.error('DELETE /catalog/admin-blocklist error:', err.message);
    res.status(500).json({ error: 'Failed to remove token from admin blocklist' });
  }
});

function buildCatalogTokenPayload(body = {}, fallbackSource = 'unknown') {
  return {
    address: String(body.address || body.mint || '').trim() || null,
    chain: normalizeChain(body.chain || 'solana'),
    source: normalizeText(body.source || fallbackSource, 64) || fallbackSource,
    symbol: normalizeText(body.symbol, 64),
    name: normalizeText(body.name, 160),
    mcap: body.mcap || null,
    price: body.price || null,
    priceChange1h: body.priceChange1h ?? null,
    priceChange6h: body.priceChange6h ?? null,
    priceChange24h: body.priceChange24h ?? null,
    tokenCreatedAt: body.tokenCreatedAt ?? null,
    pairAddress: isValidAddress(String(body.pairAddress || '').trim()) ? String(body.pairAddress).trim() : null,
    pairUrl: sanitizeHttpUrl(body.pairUrl),
    imageUrl: sanitizeAssetUrl(body.imageUrl),
    twitterUrl: sanitizeHttpUrl(body.twitterUrl),
    isActiveMonitorCandidate: body.isActiveMonitorCandidate,
  };
}

function normalizeSource(source) {
  return String(source || '').trim().toLowerCase();
}

function extractTwitterUrl(pair) {
  return sanitizeHttpUrl(pair?.info?.socials?.find((item) => item.type === 'twitter')?.url || null);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function computePctChange(currentValue, baselineValue) {
  const current = Number(currentValue);
  const baseline = Number(baselineValue);
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || !(current > 0) || !(baseline > 0)) {
    return null;
  }

  const pct = ((current - baseline) / baseline) * 100;
  return Math.abs(pct) < 0.01 ? null : pct;
}

function buildMeteoraSummary(address, summaryRow) {
  if (!summaryRow) {
    return {
      address,
      tvl: null,
      poolAddress: null,
      poolCount: 0,
      lastCheckedAt: null,
      lastSnapshotAt: null,
      change1h: null,
      change6h: null,
      change24h: null,
      noPool: true,
    };
  }

  const latestTvl = Number(summaryRow.currentTvl);
  const hasPool = summaryRow.hasPool === true && Number.isFinite(latestTvl) && latestTvl > 0;
  return {
    address,
    tvl: hasPool ? latestTvl : null,
    poolAddress: hasPool ? (summaryRow.bestPoolAddress || null) : null,
    poolCount: hasPool ? (Number(summaryRow.poolCount) || 0) : 0,
    lastCheckedAt: summaryRow.lastCheckedAt || null,
    lastSnapshotAt: summaryRow.lastSnapshotAt || null,
    change1h: hasPool ? computePctChange(latestTvl, summaryRow.baselineTvl1h) : null,
    change6h: hasPool ? computePctChange(latestTvl, summaryRow.baselineTvl6h) : null,
    change24h: hasPool ? computePctChange(latestTvl, summaryRow.baselineTvl24h) : null,
    noPool: !hasPool,
  };
}

function getMarketCap(pair) {
  return toNumber(pair?.marketCap) || toNumber(pair?.fdv) || 0;
}

function getRetryKey(userId, address, source) {
  return `${userId}:${source}:${address}`;
}

function purgeTransientRetries() {
  const now = Date.now();
  for (const [key, value] of promoteRetryState.entries()) {
    if (!value || !Number.isFinite(value.retryAt) || value.retryAt <= now) {
      promoteRetryState.delete(key);
    }
  }

  while (promoteRetryState.size > PROMOTE_RETRY_MAX_ENTRIES) {
    const oldestKey = promoteRetryState.keys().next().value;
    if (!oldestKey) break;
    promoteRetryState.delete(oldestKey);
  }
}

function setTransientRetry(userId, address, source, reason) {
  purgeTransientRetries();
  const retryAt = Date.now() + TRANSIENT_RETRY_MS;
  const key = getRetryKey(userId, address, source);
  promoteRetryState.delete(key);
  promoteRetryState.set(key, { retryAt, reason });
  purgeTransientRetries();
  return retryAt;
}

function getTransientRetry(userId, address, source) {
  purgeTransientRetries();
  const key = getRetryKey(userId, address, source);
  const current = promoteRetryState.get(key);
  if (!current) return null;
  if (Date.now() >= current.retryAt) {
    promoteRetryState.delete(key);
    return null;
  }
  return current;
}

function clearTransientRetry(userId, address, source) {
  promoteRetryState.delete(getRetryKey(userId, address, source));
}

function parseOptionalIntegerQuery(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }

  const normalized = String(value).trim();
  if (!/^-?\d+$/.test(normalized)) {
    return { ok: false, error: `${name} must be an integer` };
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }

  return { ok: true, value: parsed };
}

function parseHistoryQuery(query = {}) {
  const limit = parseOptionalIntegerQuery(query.limit, 'limit', { min: 1, max: 1000 });
  if (!limit.ok) return limit;

  const hours = parseOptionalIntegerQuery(query.hours, 'hours', { min: 1, max: 24 * 30 });
  if (!hours.ok) return hours;

  const days = parseOptionalIntegerQuery(query.days, 'days', { min: 1, max: 30 });
  if (!days.ok) return days;

  return {
    ok: true,
    options: {
      limit: limit.value,
      hours: hours.value,
      days: days.value,
    },
  };
}

function parseLateralizedQuery(query = {}) {
  const limit = parseOptionalIntegerQuery(query.limit, 'limit', { min: 1, max: 200 });
  if (!limit.ok) return limit;

  const hours = parseOptionalIntegerQuery(query.hours, 'hours', { min: 1, max: 48 });
  if (!hours.ok) return hours;

  const minMcap = parseOptionalIntegerQuery(query.minMcap, 'minMcap', { min: 90000, max: 1000000000 });
  if (!minMcap.ok) return minMcap;

  const minVol24h = parseOptionalIntegerQuery(query.minVol24h, 'minVol24h', { min: 0, max: 1000000000 });
  if (!minVol24h.ok) return minVol24h;

  return {
    ok: true,
    options: {
      limit: limit.value,
      hours: hours.value,
      minMcap: minMcap.value,
      minVol24h: minVol24h.value,
    },
  };
}

function parseBidZoneQuery(query = {}) {
  const limit = parseOptionalIntegerQuery(query.limit, 'limit', { min: 1, max: 200 });
  if (!limit.ok) return limit;

  const hours = parseOptionalIntegerQuery(query.hours, 'hours', { min: 1, max: 48 });
  if (!hours.ok) return hours;

  const minMcap = parseOptionalIntegerQuery(query.minMcap, 'minMcap', { min: 90000, max: 1000000000 });
  if (!minMcap.ok) return minMcap;

  const minVol1h = parseOptionalIntegerQuery(query.minVol1h, 'minVol1h', { min: 250, max: 1000000000 });
  if (!minVol1h.ok) return minVol1h;

  const minVol24h = parseOptionalIntegerQuery(query.minVol24h, 'minVol24h', { min: 0, max: 1000000000 });
  if (!minVol24h.ok) return minVol24h;

  return {
    ok: true,
    options: {
      limit: limit.value,
      hours: hours.value,
      minMcap: minMcap.value,
      minVol1h: minVol1h.value,
      minVol24h: minVol24h.value,
    },
  };
}

function normalizeBidZoneOptions(options = {}) {
  return {
    hours: options.hours || BID_ZONE_DEFAULT_OPTIONS.hours,
    minMcap: options.minMcap || BID_ZONE_DEFAULT_OPTIONS.minMcap,
    minVol1h: options.minVol1h || BID_ZONE_DEFAULT_OPTIONS.minVol1h,
    minVol24h: options.minVol24h || BID_ZONE_DEFAULT_OPTIONS.minVol24h,
  };
}

function isDefaultBidZoneOptions(options = {}) {
  return Number(options.hours) === BID_ZONE_DEFAULT_OPTIONS.hours
    && Number(options.minMcap) === BID_ZONE_DEFAULT_OPTIONS.minMcap
    && Number(options.minVol1h) === BID_ZONE_DEFAULT_OPTIONS.minVol1h
    && Number(options.minVol24h) === BID_ZONE_DEFAULT_OPTIONS.minVol24h;
}

function buildBidZoneResponse(payload = {}, metadata = {}) {
  return {
    generatedAt: payload.generatedAt ?? null,
    runId: payload.runId ?? null,
    requestedHours: payload.requestedHours ?? BID_ZONE_DEFAULT_OPTIONS.hours,
    minMcap: payload.minMcap ?? BID_ZONE_DEFAULT_OPTIONS.minMcap,
    minVol1h: payload.minVol1h ?? BID_ZONE_DEFAULT_OPTIONS.minVol1h,
    minVol24h: payload.minVol24h ?? BID_ZONE_DEFAULT_OPTIONS.minVol24h,
    count: Number(payload.count) || 0,
    candidateCount: payload.candidateCount ?? (Number(payload.count) || 0),
    resultCount: payload.resultCount ?? (Number(payload.count) || 0),
    refreshAvailableAt: metadata.refreshAvailableAt || null,
    refreshed: metadata.refreshed,
    retryAfterSeconds: metadata.retryAfterSeconds,
    candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
  };
}

async function getStoredBidZoneSnapshot(options = {}, resultOptions = {}) {
  const normalized = normalizeBidZoneOptions(options);
  const run = await tokenMarketBidZoneRun.getLatestCompletedRunWithResults({
    requestedHours: normalized.hours,
    minMcap: normalized.minMcap,
    minVol1h: normalized.minVol1h,
    minVol24h: normalized.minVol24h,
  }, resultOptions);
  if (!run) {
    return null;
  }

  return {
    generatedAt: run.completedAt,
    runId: run.id,
    requestedHours: run.requestedHours,
    minMcap: run.minMcap,
    minVol1h: run.minVol1h,
    minVol24h: run.minVol24h,
    count: run.candidates.length,
    candidateCount: run.candidateCount,
    resultCount: run.resultCount,
    candidates: run.candidates,
  };
}

function isHotlinkBlockedPumpfunAssetUrl(url) {
  try {
    const hostname = new URL(String(url || '').trim()).hostname.toLowerCase();
    return PUMPFUN_HOTLINK_BLOCKED_IMAGE_HOSTS.has(hostname);
  } catch (_) {
    return false;
  }
}

function toHttpAssetUrl(url) {
  const normalized = sanitizeAssetUrl(url, { allowHttp: true });
  if (!normalized) {
    return null;
  }

  // Some PumpFun metadata images are served with anti-hotlink rules and fail
  // inside the app. Reject them here so the resolver can continue to other sources.
  if (isHotlinkBlockedPumpfunAssetUrl(normalized)) {
    return null;
  }

  return normalized;
}

function toPumpfunMetadataUrl(url) {
  return sanitizeAssetUrl(url, { allowHttp: true });
}

function getPumpfunMetaCacheKey(mint, metadataUri) {
  return `${String(mint || '').trim()}|${String(metadataUri || '').trim()}`;
}

function prunePumpfunMetaCache() {
  const now = Date.now();

  for (const [key, entry] of pumpfunMetaCache.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      pumpfunMetaCache.delete(key);
    }
  }

  if (pumpfunMetaCache.size <= PUMPFUN_META_CACHE_LIMIT) {
    return;
  }

  const overflow = pumpfunMetaCache.size - PUMPFUN_META_CACHE_LIMIT;
  const removable = Array.from(pumpfunMetaCache.entries())
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, overflow);

  for (const [key] of removable) {
    pumpfunMetaCache.delete(key);
  }
}

function getCachedPumpfunMeta(mint, metadataUri) {
  prunePumpfunMetaCache();
  const entry = pumpfunMetaCache.get(getPumpfunMetaCacheKey(mint, metadataUri));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    pumpfunMetaCache.delete(getPumpfunMetaCacheKey(mint, metadataUri));
    return null;
  }
  return entry;
}

function setCachedPumpfunMeta(mint, metadataUri, status, payload, ttlMs) {
  pumpfunMetaCache.set(getPumpfunMetaCacheKey(mint, metadataUri), {
    status,
    payload,
    expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || 1000),
  });
  prunePumpfunMetaCache();
}

async function resolvePumpfunMetadataCached(mint, metadataUri) {
  const cacheKey = getPumpfunMetaCacheKey(mint, metadataUri);
  const cached = getCachedPumpfunMeta(mint, metadataUri);
  if (cached) {
    return {
      status: cached.status,
      payload: {
        ...cached.payload,
        cached: true,
      },
    };
  }

  const existingRequest = pumpfunMetaInFlight.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    const payload = await resolvePumpfunMetadata(mint, metadataUri);
    if (!payload?.imageUrl) {
      const missPayload = { error: 'PumpFun metadata unavailable', mint, cached: false };
      setCachedPumpfunMeta(
        mint,
        metadataUri,
        404,
        missPayload,
        Math.min(60000, Number(config.security?.pumpfunMetaCacheMs) || 60000)
      );
      return { status: 404, payload: missPayload };
    }

    const responsePayload = {
      mint,
      symbol: payload?.symbol || null,
      name: payload?.name || null,
      imageUrl: payload.imageUrl || null,
      cached: false,
    };
    setCachedPumpfunMeta(
      mint,
      metadataUri,
      200,
      responsePayload,
      Number(config.security?.pumpfunMetaCacheMs) || 300000
    );
    return { status: 200, payload: responsePayload };
  })()
    .catch((err) => {
      const failurePayload = { error: 'Failed to load PumpFun metadata', mint, cached: false };
      setCachedPumpfunMeta(
        mint,
        metadataUri,
        503,
        failurePayload,
        Number(config.security?.pumpfunMetaFailureCooldownMs) || 15000
      );
      logSecurityEvent('pumpfun_meta_failure_cooldown', {
        mint,
        metadataUri: metadataUri || null,
        cooldownMs: Number(config.security?.pumpfunMetaFailureCooldownMs) || 15000,
        error: err.message,
      });
      throw err;
    })
    .finally(() => {
      pumpfunMetaInFlight.delete(cacheKey);
    });

  pumpfunMetaInFlight.set(cacheKey, request);
  return request;
}

function buildMetadataGatewayUrls(uri) {
  const normalized = toPumpfunMetadataUrl(uri);
  if (!normalized) return [];

  const urls = [normalized];
  if (String(uri || '').startsWith('ipfs://')) {
    const cid = String(uri).slice('ipfs://'.length);
    urls.push(`https://cf-ipfs.com/ipfs/${cid}`);
    urls.push(`https://gateway.pinata.cloud/ipfs/${cid}`);
  } else if (normalized.includes('/ipfs/')) {
    const cid = normalized.split('/ipfs/')[1];
    if (cid) {
      urls.push(`https://cf-ipfs.com/ipfs/${cid}`);
      urls.push(`https://gateway.pinata.cloud/ipfs/${cid}`);
    }
  }

  return [...new Set(urls)];
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    return { ok: false, status: response.status, body: null };
  }

  return {
    ok: true,
    status: response.status,
    body: await response.json(),
  };
}

async function resolvePumpfunMetadata(mint, metadataUri) {
  let bestSymbol = null;
  let bestName = null;

  try {
    const pump = await fetchJsonWithTimeout(`https://frontend-api.pump.fun/coins/${mint}`);
    if (pump.ok && pump.body) {
      bestSymbol = pump.body.symbol || bestSymbol;
      bestName = pump.body.name || bestName;

      const imageUrl = toHttpAssetUrl(pump.body.image_uri || pump.body.image || null);
      if (imageUrl) {
        return {
          symbol: bestSymbol,
          name: bestName,
          imageUrl,
        };
      }
    }
  } catch (_) {
    // Fall through to URI/Dex fallbacks when PumpFun is unavailable upstream.
  }

  for (const url of buildMetadataGatewayUrls(metadataUri)) {
    try {
      const metadata = await fetchJsonWithTimeout(url);
      if (metadata.ok && metadata.body) {
        bestSymbol = metadata.body.symbol || bestSymbol;
        bestName = metadata.body.name || bestName;
        const imageUrl = toHttpAssetUrl(metadata.body.image || metadata.body.image_url || null);
        if (imageUrl) {
          return {
            symbol: metadata.body.symbol || bestSymbol,
            name: metadata.body.name || bestName,
            imageUrl,
          };
        }
      }
    } catch (_) {
      // Try the next gateway.
    }
  }

  try {
    const dexData = await dexscreener.getTokenPairs(mint);
    const bestPair = dexscreener.getBestPair(dexData, 'solana');
    if (bestPair) {
      const imageUrl = toHttpAssetUrl(bestPair.info?.imageUrl || bestPair.info?.header || bestPair.baseToken?.logoUri || null);
      if (!imageUrl) {
        return null;
      }
      return {
        symbol: bestPair.baseToken?.symbol || bestSymbol,
        name: bestPair.baseToken?.name || bestName,
        imageUrl,
      };
    }
  } catch (_) {
    // Leave the placeholder if Dex also has no image.
  }

  return null;
}

async function buildValidatedPromotion(user, body = {}) {
  const requested = buildCatalogTokenPayload(body, 'unknown');
  const address = String(requested.address || '').trim();
  if (!isValidAddress(address)) {
    return { status: 400, error: 'Invalid token address' };
  }

  const source = normalizeSource(requested.source);
  const chain = normalizeChain(requested.chain || 'solana');

  if (source !== 'monitored-token') {
    return { status: 400, error: 'Unsupported promotion source' };
  }

  const manualTokens = new Set((await userToken.getAll(user.id)).map((item) => item.address));
  if (manualTokens.has(address)) {
    return { status: 409, error: 'Manual tokens are persisted via the user config flow' };
  }

  const cooldown = getTransientRetry(user.id, address, source);
  if (cooldown) {
    return {
      status: 202,
      error: 'Promotion validation deferred',
      retryAt: cooldown.retryAt,
      reason: cooldown.reason,
    };
  }

  const data = await dexscreener.getTokenPairs(address);
  if (!data?.pairs?.length) {
    return {
      status: 202,
      error: 'Dex data unavailable; retry later',
      retryAt: setTransientRetry(user.id, address, source, 'dex_unavailable'),
      reason: 'dex_unavailable',
    };
  }

  const bestPair = dexscreener.getBestPair(data, chain);
  if (!bestPair) {
    return {
      status: 202,
      error: 'Dex pair not indexed yet; retry later',
      retryAt: setTransientRetry(user.id, address, source, 'pair_unavailable'),
      reason: 'pair_unavailable',
    };
  }

  const marketCap = getMarketCap(bestPair);
  if (!(marketCap >= MONITORED_MIN_MCAP)) {
    clearTransientRetry(user.id, address, source);
    return { status: 422, error: `Token market cap must be at least $${MONITORED_MIN_MCAP}` };
  }

  clearTransientRetry(user.id, address, source);

  return {
    status: 200,
    token: {
      address,
      chain,
      source,
      symbol: bestPair.baseToken?.symbol || requested.symbol,
      name: bestPair.baseToken?.name || requested.name,
      mcap: marketCap,
      price: toNumber(bestPair.priceUsd),
      priceChange1h: toNumber(bestPair?.priceChange?.h1),
      priceChange6h: toNumber(bestPair?.priceChange?.h6),
      priceChange24h: toNumber(bestPair?.priceChange?.h24),
      tokenCreatedAt: toNumber(bestPair?.pairCreatedAt),
      pairAddress: bestPair.pairAddress || requested.pairAddress,
      pairUrl: bestPair.url || requested.pairUrl,
      imageUrl: bestPair.info?.imageUrl || requested.imageUrl,
      twitterUrl: extractTwitterUrl(bestPair) || requested.twitterUrl,
      isActiveMonitorCandidate: requested.isActiveMonitorCandidate,
    },
  };
}

router.get('/history/:address', catalogReadLimiter, async (req, res) => {
  try {
    const address = String(req.params?.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const parsedQuery = parseHistoryQuery(req.query);
    if (!parsedQuery.ok) {
      return res.status(400).json({ error: parsedQuery.error });
    }

    const snapshots = await tokenMarketBucket1m.listHistoryByAddress(address, parsedQuery.options);

    res.json({
      address,
      count: snapshots.length,
      snapshots,
    });
  } catch (err) {
    console.error('GET /catalog/history/:address error:', err.message);
    res.status(500).json({ error: 'Failed to load token history' });
  }
});

router.get('/lateralized', catalogReadLimiter, async (req, res) => {
  try {
    const parsedQuery = parseLateralizedQuery(req.query);
    if (!parsedQuery.ok) {
      return res.status(400).json({ error: parsedQuery.error });
    }

    const requestedHours = parsedQuery.options.hours || 6;
    const minMcap = parsedQuery.options.minMcap || 90000;
    const minVol24h = parsedQuery.options.minVol24h || 10000;
    const limit = parsedQuery.options.limit || 50;
    const run = await tokenMarketLateralizationRun.getLatestCompletedRunWithResults({
      requestedHours,
      minMcap,
      minVol24h,
    }, {
      limit,
    });
    if (!run) {
      return res.status(404).json({
        error: 'No completed lateralization run available for the requested parameters',
      });
    }

    res.json({
      generatedAt: run.completedAt,
      runId: run.id,
      hours: run.requestedHours,
      requestedHours: run.requestedHours,
      windowPolicy: {
        sub1mMinHours: 16,
        gte1mMinHours: 32,
      },
      minMcap: run.minMcap,
      minVol24h: run.minVol24h,
      count: run.candidates.length,
      candidateCount: run.candidateCount,
      resultCount: run.resultCount,
      candidates: run.candidates,
    });
  } catch (err) {
    console.error('GET /catalog/lateralized error:', err.message);
    res.status(500).json({ error: 'Failed to load lateralized candidates' });
  }
});

router.get('/bid-zone', catalogReadLimiter, async (req, res) => {
  try {
    const parsedQuery = parseBidZoneQuery(req.query);
    if (!parsedQuery.ok) {
      return res.status(400).json({ error: parsedQuery.error });
    }

    const options = normalizeBidZoneOptions(parsedQuery.options);
    const limit = parsedQuery.options.limit || BID_ZONE_DEFAULT_OPTIONS.limit;
    const refreshAvailableAt = bidZoneWorker.getStatus().refreshAvailableAt;

    if (isDefaultBidZoneOptions(options)) {
      const storedSnapshot = await getStoredBidZoneSnapshot(options, { limit });
      if (!storedSnapshot) {
        return res.status(404).json({
          error: 'No completed bid-zone snapshot available for the requested parameters',
        });
      }

      return res.json(buildBidZoneResponse(storedSnapshot, { refreshAvailableAt }));
    }

    const candidates = await tokenMarketBucket1m.listBidZoneCandidates({
      ...options,
      limit,
    });
    return res.json(buildBidZoneResponse({
      generatedAt: new Date().toISOString(),
      runId: null,
      requestedHours: options.hours,
      minMcap: options.minMcap,
      minVol1h: options.minVol1h,
      minVol24h: options.minVol24h,
      count: candidates.length,
      candidateCount: candidates.length,
      resultCount: candidates.length,
      candidates,
    }, { refreshAvailableAt }));
  } catch (err) {
    console.error('GET /catalog/bid-zone error:', err.message);
    res.status(500).json({ error: 'Failed to load bid-zone candidates' });
  }
});

router.post('/bid-zone/refresh', catalogWriteLimiter, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || BID_ZONE_DEFAULT_OPTIONS.limit, 200));
    const refresh = await bidZoneWorker.runManualRefresh(BID_ZONE_DEFAULT_OPTIONS);
    const snapshot = await getStoredBidZoneSnapshot(BID_ZONE_DEFAULT_OPTIONS, { limit });

    if (!snapshot) {
      return res.status(500).json({ error: 'Failed to load bid-zone snapshot after refresh attempt' });
    }

    res.json(buildBidZoneResponse(snapshot, {
      refreshAvailableAt: refresh.refreshAvailableAt,
      refreshed: refresh.accepted,
      retryAfterSeconds: refresh.retryAfterSeconds,
    }));
  } catch (err) {
    console.error('POST /catalog/bid-zone/refresh error:', err.message);
    res.status(500).json({ error: 'Failed to refresh bid-zone snapshot' });
  }
});

router.post('/meteora/batch', catalogReadLimiter, async (req, res) => {
  try {
    const parsed = parseMeteoraBatchAddresses(req.body?.addresses);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    const rows = await tokenMeteoraState.listSummaryByAddresses(parsed.addresses);
    const byAddress = new Map(rows.map((row) => [row.tokenAddress, row]));

    res.json({
      count: parsed.addresses.length,
      items: parsed.addresses.map((address) => buildMeteoraSummary(address, byAddress.get(address) || null)),
    });
  } catch (err) {
    console.error('POST /catalog/meteora/batch error:', err.message);
    res.status(500).json({ error: 'Failed to load Meteora batch summary' });
  }
});

router.get('/meteora/:address/history', catalogReadLimiter, async (req, res) => {
  try {
    const address = String(req.params?.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const parsedQuery = parseHistoryQuery(req.query);
    if (!parsedQuery.ok) {
      return res.status(400).json({ error: parsedQuery.error });
    }

    const [snapshots, summaryRow] = await Promise.all([
      tokenMeteoraSnapshot.listHistoryByAddress(address, parsedQuery.options),
      tokenMeteoraState.getSummaryByAddress(address),
    ]);

    res.json({
      address,
      count: snapshots.length,
      snapshots,
      summary: buildMeteoraSummary(address, summaryRow),
    });
  } catch (err) {
    console.error('GET /catalog/meteora/:address/history error:', err.message);
    res.status(500).json({ error: 'Failed to load Meteora history' });
  }
});

router.get('/pumpfun/:mint/meta', pumpfunMetaLimiter, async (req, res) => {
  try {
    const mint = String(req.params?.mint || '').trim();
    const rawMetadataUri = String(req.query?.uri || '').trim();
    const metadataUri = rawMetadataUri ? toPumpfunMetadataUrl(rawMetadataUri) || null : null;
    if (!isValidAddress(mint)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }
    if (rawMetadataUri && !metadataUri) {
      return res.status(400).json({ error: 'Invalid metadata URI' });
    }

    const result = await resolvePumpfunMetadataCached(mint, metadataUri);
    res.status(result.status).json(result.payload);
  } catch (err) {
    console.error('GET /catalog/pumpfun/:mint/meta error:', err.message);
    res.status(500).json({ error: 'Failed to load PumpFun metadata' });
  }
});

router.post('/promote', catalogWriteLimiter, async (req, res) => {
  try {
    const validation = await buildValidatedPromotion(req.user, req.body);
    if (validation.status !== 200) {
      return res.status(validation.status).json({
        error: validation.error,
        retryAt: validation.retryAt || null,
        reason: validation.reason || null,
      });
    }

    const token = await tokenCatalog.upsertToken(validation.token);
    res.status(201).json({ message: 'Token cataloged', token });
  } catch (err) {
    console.error('POST /catalog/promote error:', err.message);
    res.status(500).json({ error: 'Failed to catalog token' });
  }
});

router.post('/migrated', catalogWriteLimiter, async (req, res) => {
  try {
    const tokenInput = buildCatalogTokenPayload(req.body, 'pumpfun-migrated');
    const address = String(tokenInput.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    logTrace('api_catalog_migrated_received', {
      tokenAddress: address,
      source: 'pumpfun-migrated',
      symbol: tokenInput.symbol || null,
      name: tokenInput.name || null,
      marketCap: Number.isFinite(Number(tokenInput.mcap)) ? Number(tokenInput.mcap) : null,
    });

    const token = await tokenCatalog.upsertToken({
      ...tokenInput,
      address,
      isActiveMonitorCandidate: tokenInput.isActiveMonitorCandidate == null
        ? true
        : tokenInput.isActiveMonitorCandidate,
    });

    logTrace('api_catalog_migrated_upsert_ok', {
      tokenAddress: token?.address || address,
      source: token?.source || 'pumpfun-migrated',
      nextEvaluationAt: token?.next_evaluation_at || null,
      migrationGraceUntil: token?.migration_grace_until || null,
      marketCap: token?.last_mcap == null ? null : Number(token.last_mcap),
    });

    res.status(201).json({ message: 'Migrated token cataloged', token });
  } catch (err) {
    logTrace('api_catalog_migrated_upsert_error', {
      tokenAddress: req.body?.address || null,
      source: 'pumpfun-migrated',
      error: err.message,
    }, { level: 'error' });
    console.error('POST /catalog/migrated error:', err.message);
    res.status(500).json({ error: 'Failed to catalog migrated token' });
  }
});

module.exports = router;
