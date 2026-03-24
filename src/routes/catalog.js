const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const { catalogReadLimiter, catalogWriteLimiter, pumpfunMetaLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const userToken = require('../models/user-token');
const dexscreener = require('../services/dexscreener');
const { isValidAddress } = require('../models/user-token');
const { normalizeChain, normalizeText, sanitizeHttpUrl, sanitizeAssetUrl } = require('../utils/url-safety');

const MONITORED_MIN_MCAP = 30000;
const TRANSIENT_RETRY_MS = 40000;
const METEORA_DELTA_1H_MS = 60 * 60 * 1000;
const METEORA_DELTA_6H_MS = 6 * 60 * 60 * 1000;
const METEORA_DELTA_24H_MS = 24 * 60 * 60 * 1000;
const PROMOTE_RETRY_MAX_ENTRIES = 2000;
const promoteRetryState = new Map();

function normalizeMinMcap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_MCAP;
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

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function computeMeteoraDelta(history, latestTvl, windowMs) {
  if (!Array.isArray(history) || history.length < 2 || !(latestTvl > 0)) {
    return null;
  }

  const now = Date.now();
  const targetTs = now - windowMs;
  let baseline = null;

  for (const point of history) {
    const pointTs = toDateOrNull(point.ts)?.getTime();
    const tvl = Number(point.total_tvl);
    if (!Number.isFinite(pointTs) || !(tvl > 0)) {
      continue;
    }

    if (pointTs <= targetTs) {
      baseline = { ts: pointTs, tvl };
    } else if (!baseline) {
      baseline = { ts: pointTs, tvl };
      break;
    } else {
      break;
    }
  }

  if (!baseline || !(baseline.tvl > 0)) {
    return null;
  }

  const pct = ((latestTvl - baseline.tvl) / baseline.tvl) * 100;
  return Math.abs(pct) < 0.01 ? null : pct;
}

function buildMeteoraSummary(address, historyRows) {
  const latest = historyRows[historyRows.length - 1] || null;
  if (!latest) {
    return {
      address,
      tvl: null,
      poolAddress: null,
      poolCount: 0,
      lastSnapshotAt: null,
      change1h: null,
      change6h: null,
      change24h: null,
      noPool: true,
    };
  }

  const latestTvl = Number(latest.total_tvl);
  return {
    address,
    tvl: Number.isFinite(latestTvl) ? latestTvl : null,
    poolAddress: latest.best_pool_address || null,
    poolCount: Number(latest.pool_count) || 0,
    lastSnapshotAt: latest.ts || null,
    change1h: computeMeteoraDelta(historyRows, latestTvl, METEORA_DELTA_1H_MS),
    change6h: computeMeteoraDelta(historyRows, latestTvl, METEORA_DELTA_6H_MS),
    change24h: computeMeteoraDelta(historyRows, latestTvl, METEORA_DELTA_24H_MS),
    noPool: false,
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

function toHttpAssetUrl(url) {
  return sanitizeAssetUrl(url, { allowHttp: true });
}

function toPumpfunMetadataUrl(url) {
  return sanitizeAssetUrl(url, { allowHttp: true });
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

    const hours = parsedQuery.options.hours || 6;
    const minMcap = parsedQuery.options.minMcap || 90000;
    const minVol24h = parsedQuery.options.minVol24h || 10000;
    const limit = parsedQuery.options.limit || 50;
    const candidates = await tokenMarketBucket1m.listLateralizedCandidates({
      hours,
      minMcap,
      minVol24h,
      limit,
    });

    res.json({
      hours,
      minMcap,
      minVol24h,
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    console.error('GET /catalog/lateralized error:', err.message);
    res.status(500).json({ error: 'Failed to load lateralized candidates' });
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

    const snapshots = await tokenMeteoraSnapshot.listHistoryByAddress(address, parsedQuery.options);

    res.json({
      address,
      count: snapshots.length,
      snapshots,
      summary: buildMeteoraSummary(address, snapshots),
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

    const payload = await resolvePumpfunMetadata(mint, metadataUri);
    if (!payload?.imageUrl) {
      return res.status(404).json({ error: 'PumpFun metadata unavailable' });
    }

    res.json({
      mint,
      symbol: payload?.symbol || null,
      name: payload?.name || null,
      imageUrl: payload.imageUrl || null,
    });
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

    const token = await tokenCatalog.upsertToken({
      ...tokenInput,
      address,
      isActiveMonitorCandidate: tokenInput.isActiveMonitorCandidate == null
        ? true
        : tokenInput.isActiveMonitorCandidate,
    });

    res.status(201).json({ message: 'Migrated token cataloged', token });
  } catch (err) {
    console.error('POST /catalog/migrated error:', err.message);
    res.status(500).json({ error: 'Failed to catalog migrated token' });
  }
});

module.exports = router;
