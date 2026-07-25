const express = require('express');
const router = express.Router();
const config = require('../../config');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const { catalogReadLimiter, catalogWriteLimiter, pumpfunMetaLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenRiskReview = require('../models/token-risk-review');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const {
  ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES,
  MAX_COMPACT_SPARKLINE_POINTS,
  MAX_SPARKLINE_GRANULARITY_MINUTES,
  isSparklineGranularityMinutes,
} = require('../utils/market-bucket-granularities');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const tokenMarketBidZoneRun = require('../models/token-market-bid-zone-run');
const tokenMeteoraState = require('../models/token-meteora-state');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const userToken = require('../models/user-token');
const dexscreener = require('../services/dexscreener');
const manualTokenBootstrap = require('../services/manual-token-bootstrap');
const uiMeteoraSummaryCache = require('../services/ui-meteora-summary-cache');
const alertTickerPeers = require('../services/alert-ticker-peers');
const catalogMarketHistory = require('../services/catalog-market-history');
const { isValidAddress } = require('../models/user-token');
const { createTokenIdentity } = require('../utils/token-identity');
const { logSecurityEvent } = require('../utils/security-events');
const { normalizeChain, normalizeText, sanitizeHttpUrl, sanitizeAssetUrl } = require('../utils/url-safety');
const { extractDexSocialLinks, normalizeSocialLinkFields } = require('../utils/dex-social-links');
const { logTrace } = require('../utils/pump-migrate-trace');
const { rejectHiddenRobinhoodRequests } = require('../middleware/token-chain-visibility');
const {
  attachResponsePerfHeaders,
  isEnabled: isPerfMetricsEnabled,
  logRequestPerf,
  nowMs,
} = require('../utils/perf-metrics');
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

function parseOptionalBooleanBodyField(value, defaultValue = true, name = 'includeMeteora') {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: defaultValue };
  }

  if (typeof value === 'boolean') {
    return { ok: true, value };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return { ok: true, value: true };
  }
  if (normalized === 'false') {
    return { ok: true, value: false };
  }

  return { ok: false, error: `${name} must be a boolean` };
}

function parseOptionalIntegerBodyField(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
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

function parseSparklineIdentities(values) {
  if (!Array.isArray(values) || !values.length) {
    return { ok: false, error: 'identities is required' };
  }
  if (values.length > 500) {
    return { ok: false, error: 'identities must contain 500 items or fewer' };
  }
  const byKey = new Map();
  try {
    for (const value of values) {
      const identity = createTokenIdentity(value?.chain, value?.address);
      if (identity.chain !== 'solana' && identity.chain !== 'robinhood') {
        return { ok: false, error: `Market history is unavailable for ${identity.chain}` };
      }
      byKey.set(identity.key, identity);
    }
  } catch (_) {
    return { ok: false, error: 'Invalid token identity' };
  }
  const identities = [...byKey.values()];
  if (identities.filter((identity) => identity.chain === 'robinhood').length > 100) {
    return { ok: false, error: 'identities must contain 100 Robinhood items or fewer' };
  }
  return { ok: true, identities };
}

function parseAllAvailableSparklineFields(body, granularityMinutes) {
  const allAvailable = parseOptionalBooleanBodyField(
    body.allAvailable,
    false,
    'allAvailable'
  );
  if (!allAvailable.ok) return allAvailable;
  if (allAvailable.value && granularityMinutes != null
    && granularityMinutes !== ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES) {
    return { ok: false, error: 'allAvailable sparklines require 60-minute granularity' };
  }
  return { ok: true, value: allAvailable.value };
}

function parseSparklineBatchRequest(body = {}) {
  let identities;
  if (body.identities == null) {
    const addresses = parseMeteoraBatchAddresses(body.addresses);
    if (!addresses.ok) return addresses;
    identities = addresses.addresses.map((address) => createTokenIdentity('solana', address));
  } else {
    const parsed = parseSparklineIdentities(body.identities);
    if (!parsed.ok) return parsed;
    identities = parsed.identities;
  }

  const hours = parseOptionalIntegerBodyField(body.hours, 'hours', { min: 1, max: 24 * 30 });
  if (!hours.ok) {
    return hours;
  }

  const points = parseOptionalIntegerBodyField(
    body.points, 'points', { min: 10, max: MAX_COMPACT_SPARKLINE_POINTS }
  );
  if (!points.ok) {
    return points;
  }

  const granularityMinutes = parseOptionalIntegerBodyField(
    body.granularityMinutes,
    'granularityMinutes',
    { min: 1, max: MAX_SPARKLINE_GRANULARITY_MINUTES }
  );
  if (!granularityMinutes.ok) {
    return granularityMinutes;
  }
  if (granularityMinutes.value != null && !isSparklineGranularityMinutes(granularityMinutes.value)) {
    return { ok: false, error: 'granularityMinutes must be one of 1, 5, 15, 30, 60, 240, 1440' };
  }

  const allowOneMinuteFallback = parseOptionalBooleanBodyField(
    body.allowOneMinuteFallback,
    false,
    'allowOneMinuteFallback'
  );
  if (!allowOneMinuteFallback.ok) {
    return allowOneMinuteFallback;
  }
  const allAvailable = parseAllAvailableSparklineFields(body, granularityMinutes.value);
  if (!allAvailable.ok) return allAvailable;

  return {
    ok: true,
    value: {
      identities,
      allAvailable: allAvailable.value,
      hours: allAvailable.value ? null : (hours.value || (14 * 24)),
      points: points.value || (allAvailable.value ? MAX_COMPACT_SPARKLINE_POINTS : 336),
      granularityMinutes: allAvailable.value
        ? ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES
        : (granularityMinutes.value || 30),
      allowOneMinuteFallback: allowOneMinuteFallback.value,
    },
  };
}

function parseExpandedSparklineRequest(body = {}) {
  let identity;
  try {
    identity = createTokenIdentity(body.chain || 'solana', body.address);
  } catch (_) {
    return { ok: false, error: 'Invalid token address' };
  }
  if (identity.chain !== 'solana' && identity.chain !== 'robinhood') {
    return { ok: false, error: `Expanded market history is unavailable for ${identity.chain}` };
  }

  const points = parseOptionalIntegerBodyField(body.points, 'points', { min: 120, max: 1000 });
  if (!points.ok) {
    return points;
  }

  const granularityMinutes = parseOptionalIntegerBodyField(
    body.granularityMinutes,
    'granularityMinutes',
    { min: 1, max: MAX_SPARKLINE_GRANULARITY_MINUTES }
  );
  if (!granularityMinutes.ok) {
    return granularityMinutes;
  }
  if (granularityMinutes.value != null && !isSparklineGranularityMinutes(granularityMinutes.value)) {
    return { ok: false, error: 'granularityMinutes must be one of 1, 5, 15, 30, 60, 240, 1440' };
  }

  const allowOneMinuteFallback = parseOptionalBooleanBodyField(
    body.allowOneMinuteFallback,
    false,
    'allowOneMinuteFallback'
  );
  if (!allowOneMinuteFallback.ok) {
    return allowOneMinuteFallback;
  }

  return {
    ok: true,
    value: {
      chain: identity.chain,
      address: identity.address,
      points: points.value || 720,
      granularityMinutes: granularityMinutes.value,
      allowOneMinuteFallback: allowOneMinuteFallback.value,
    },
  };
}

router.use(authenticate);
router.use(requireTrustedOrigin);
router.use(rejectHiddenRobinhoodRequests);

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

    const bootstrap = await manualTokenBootstrap.upsertManualCatalogToken(address, {
      eagerEvaluate: true,
    });

    res.status(201).json({
      message: 'Manual token scheduled for catalog tracking',
      tracked: { address },
      bootstrapState: bootstrap.bootstrapState,
    });
  } catch (err) {
    console.error('POST /catalog/manual-track error:', err.message);
    res.status(500).json({ error: 'Failed to schedule manual token tracking' });
  }
});

router.post('/monitored-metadata-batch', catalogReadLimiter, async (req, res) => {
  const parsed = parseMeteoraBatchAddresses(req.body?.addresses);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const includeMeteora = parseOptionalBooleanBodyField(req.body?.includeMeteora, true);
  if (!includeMeteora.ok) {
    return res.status(400).json({ error: includeMeteora.error });
  }

  try {
    const startedAt = nowMs();
    const addresses = parsed.addresses;
    const [metadataRows, meteoraSummaryRows, primaryMarketBaselineRows, primaryVolumeBaselineRows] = await Promise.all([
      tokenCatalog.listDashboardMetadataByAddresses(addresses),
      includeMeteora.value ? uiMeteoraSummaryCache.listUiSummaryByAddresses(addresses) : Promise.resolve([]),
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    ]);

    const metadataByAddress = new Map(metadataRows.map((row) => [row.address, row]));
    const meteoraByAddress = new Map(meteoraSummaryRows.map((row) => [row.tokenAddress, row]));
    const marketMcapBaselineByAddress = new Map(primaryMarketBaselineRows.map((row) => [row.token_address, row]));
    const marketVolumeBaselineByAddress = new Map(primaryVolumeBaselineRows.map((row) => [row.token_address, row]));
    const tickerPeersByAddress = await loadTickerPeerSummariesSafe(metadataRows);

    const tokens = addresses
      .map((address) => {
        const item = metadataByAddress.get(address);
        if (!item) {
          return null;
        }

        return buildMonitoredMetadataPayload(
          item,
          meteoraByAddress,
          marketMcapBaselineByAddress,
          marketVolumeBaselineByAddress,
          { includeMeteora: includeMeteora.value, tickerPeersByAddress },
        );
      })
      .filter(Boolean);

    const payload = {
      generatedAt: new Date().toISOString(),
      count: tokens.length,
      tokens,
    };
    const totalDurationMs = nowMs() - startedAt;
    const perf = attachResponsePerfHeaders(res, 'catalog.monitored-metadata-batch', payload, {
      total: totalDurationMs,
    });
    logRequestPerf(req, 'catalog.monitored-metadata-batch', {
      addresses: addresses.length,
      includeMeteora: includeMeteora.value,
      metadataRows: metadataRows.length,
      meteoraRows: meteoraSummaryRows.length,
      marketBaselineRows: primaryMarketBaselineRows.length,
      volumeBaselineRows: primaryVolumeBaselineRows.length,
      tickerPeerRows: tickerPeersByAddress.size,
      items: tokens.length,
      totalMs: totalDurationMs,
      responseBytes: perf.responseBytes,
    });

    res.json(payload);
  } catch (err) {
    console.error('POST /catalog/monitored-metadata-batch error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored metadata batch' });
  }
});

router.post('/sparklines', catalogReadLimiter, async (req, res) => {
  const parsed = parseSparklineBatchRequest(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const startedAt = nowMs();
    let modelMetrics = null;
    const sparklineOptions = { ...parsed.value };
    if (isPerfMetricsEnabled()) {
      sparklineOptions.onMetrics = (metrics) => {
        modelMetrics = metrics;
      };
    }

    const payload = await catalogMarketHistory.getSparklineBatch(sparklineOptions);
    const totalDurationMs = nowMs() - startedAt;
    const perf = attachResponsePerfHeaders(res, 'catalog.sparklines', payload, {
      total: totalDurationMs,
      query: modelMetrics?.queryDurationMs,
      build: modelMetrics?.buildDurationMs,
    });
    logRequestPerf(req, 'catalog.sparklines', {
      identities: parsed.value.identities.length,
      uniqueAddresses: modelMetrics?.addresses,
      rows: modelMetrics?.rows,
      source: modelMetrics?.source,
      cacheHit: modelMetrics?.cacheHit,
      aggregateRows: modelMetrics?.aggregateRows,
      fallbackRows: modelMetrics?.fallbackRows,
      fallbackAddresses: modelMetrics?.fallbackAddresses,
      items: payload.items.length,
      hours: parsed.value.hours,
      points: parsed.value.points,
      granularityMinutes: parsed.value.granularityMinutes,
      queryMs: modelMetrics?.queryDurationMs,
      buildMs: modelMetrics?.buildDurationMs,
      modelMs: modelMetrics?.totalDurationMs,
      totalMs: totalDurationMs,
      responseBytes: perf.responseBytes,
    });

    res.json(payload);
  } catch (err) {
    console.error('POST /catalog/sparklines error:', err.message);
    res.status(500).json({ error: 'Failed to load token sparklines' });
  }
});

router.post('/sparklines/expanded', catalogReadLimiter, async (req, res) => {
  const parsed = parseExpandedSparklineRequest(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    res.json(await catalogMarketHistory.getExpandedSparkline(parsed.value));
  } catch (err) {
    console.error('POST /catalog/sparklines/expanded error:', err.message);
    res.status(500).json({ error: 'Failed to load expanded token sparkline' });
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
    await tokenRiskReview.removeAutoReview(address, undefined, 'solana');

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

    await tokenCatalog.reactivateAdminBlockedToken(address).catch(() => null);

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
    communityUrl: sanitizeHttpUrl(body.communityUrl),
    isActiveMonitorCandidate: body.isActiveMonitorCandidate,
  };
}

function normalizeSource(source) {
  return String(source || '').trim().toLowerCase();
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

function buildMarketBaseline(mcapBaselineRow, volumeBaselineRow) {
  const currentMcap = toNumber(mcapBaselineRow?.current_mcap);
  const previousMcap = toNumber(mcapBaselineRow?.baseline_mcap);
  const previousVolume5m = toNumber(volumeBaselineRow?.baseline_vol_5m);
  const mcapDelta = currentMcap != null && previousMcap != null && previousMcap > 0
    ? ((currentMcap - previousMcap) / previousMcap) * 100
    : null;

  return {
    prevMcap: Number.isFinite(previousMcap) ? previousMcap : null,
    mcapDelta: Number.isFinite(mcapDelta) ? mcapDelta : null,
    prevVolume5mCanonical: Number.isFinite(previousVolume5m) ? previousVolume5m : null,
  };
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
      change4h: null,
      change6h: null,
      change24h: null,
      volume1h: null,
      volume4h: null,
      volume24h: null,
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
    change4h: hasPool ? computePctChange(latestTvl, summaryRow.baselineTvl4h) : null,
    change6h: hasPool ? computePctChange(latestTvl, summaryRow.baselineTvl6h) : null,
    change24h: hasPool ? computePctChange(latestTvl, summaryRow.baselineTvl24h) : null,
    volume1h: hasPool ? summaryRow.volume1h : null,
    volume4h: hasPool ? summaryRow.volume4h : null,
    volume24h: hasPool ? summaryRow.volume24h : null,
    noPool: !hasPool,
  };
}

function buildMonitoredMetadataPayload(
  item,
  meteoraByAddress,
  marketMcapBaselineByAddress,
  marketVolumeBaselineByAddress,
  options = {},
) {
  const includeMeteora = options.includeMeteora !== false;
  const marketBaseline = buildMarketBaseline(
    marketMcapBaselineByAddress.get(item.address) || null,
    marketVolumeBaselineByAddress.get(item.address) || null
  );
  const socialLinks = normalizeSocialLinkFields({
    twitterUrl: item.last_twitter_url,
    communityUrl: item.last_community_url,
  });
  const tickerPeers = options.tickerPeersByAddress?.get(item.address) || null;

  return {
    address: item.address,
    symbol: item.symbol || null,
    name: item.name || null,
    pairAddress: item.last_pair_address || null,
    pairUrl: item.last_pair_url || null,
    pairDexId: normalizeText(item.last_dex_id, 64),
    imageUrl: item.last_image_url || null,
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    eligibleForMonitoring: Boolean(item.eligible_for_monitoring),
    monitorPriority: item.monitor_priority || 'dormant',
    mcap: toNumber(item.last_mcap),
    priceUsd: toNumber(item.last_price),
    liquidityUsd: toNumber(item.last_liquidity_usd),
    volume5m: toNumber(item.last_vol_5m),
    volume1h: toNumber(item.last_vol_1h),
    volume6h: toNumber(item.last_vol_6h),
    volume24h: toNumber(item.last_vol_24h),
    priceChange1h: toNumber(item.last_price_change_1h),
    priceChange6h: toNumber(item.last_price_change_6h),
    priceChange24h: toNumber(item.last_price_change_24h),
    tokenCreatedAt: Number.isFinite(Number(item.last_token_created_at_ms)) ? Number(item.last_token_created_at_ms) : null,
    prevMcap: marketBaseline.prevMcap,
    mcapDelta: marketBaseline.mcapDelta,
    prevVolume5mCanonical: marketBaseline.prevVolume5mCanonical,
    lastSeenAt: item.last_seen_at || null,
    lastEvaluatedAt: item.last_evaluated_at || null,
    tickerPeers,
    meteora: includeMeteora
      ? buildMeteoraSummary(item.address, meteoraByAddress.get(item.address) || null)
      : null,
  };
}

async function loadTickerPeerSummariesSafe(items = []) {
  try {
    return await alertTickerPeers.listTickerPeerSummariesForTokens(items);
  } catch (err) {
    console.warn('[Catalog] Failed to load monitored ticker peer summaries:', err.message);
    return new Map();
  }
}

function getMarketCap(pair) {
  return dexscreener.resolveOperationalMarketCap(pair) || 0;
}

function getPairDexId(pair) {
  return normalizeText(pair?.dexId, 64);
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

async function enrichDashboardCandidateMetadata(candidates = []) {
  const baseCandidates = Array.isArray(candidates) ? candidates : [];
  if (!baseCandidates.length) {
    return [];
  }

  const metadataRows = await tokenCatalog.listDashboardMetadataByAddresses(
    baseCandidates.map((item) => item?.address).filter(Boolean)
  );
  const metadataByAddress = new Map(metadataRows.map((row) => [row.address, row]));

  return baseCandidates.map((item) => {
    const metadata = metadataByAddress.get(item.address);
    if (!metadata) {
      return item;
    }
    const socialLinks = normalizeSocialLinkFields({
      twitterUrl: item.twitterUrl ?? metadata.last_twitter_url,
      communityUrl: item.communityUrl ?? metadata.last_community_url,
    });

    return {
      ...item,
      symbol: item.symbol ?? metadata.symbol ?? null,
      name: item.name ?? metadata.name ?? null,
      monitorPriority: item.monitorPriority ?? metadata.monitor_priority ?? null,
      pairAddress: item.pairAddress ?? metadata.last_pair_address ?? null,
      pairUrl: item.pairUrl ?? metadata.last_pair_url ?? null,
      imageUrl: item.imageUrl ?? metadata.last_image_url ?? null,
      twitterUrl: socialLinks.twitterUrl,
      communityUrl: socialLinks.communityUrl,
    };
  });
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
  const socialLinks = extractDexSocialLinks(bestPair);
  const pairDexId = getPairDexId(bestPair);

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
      dexId: pairDexId,
      imageUrl: bestPair.info?.imageUrl || requested.imageUrl,
      twitterUrl: socialLinks.twitterUrl || requested.twitterUrl,
      communityUrl: socialLinks.communityUrl || requested.communityUrl,
      isActiveMonitorCandidate: requested.isActiveMonitorCandidate,
    },
  };
}

function buildTickerPeerListResponse(identity, snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return {
    chain: identity.chain,
    address: identity.address,
    count: items.length,
    exactCount: snapshot?.exactCount ?? null,
    oldestExactAddress: snapshot?.oldestExactAddress || null,
    highestMcapExactAddress: snapshot?.highestMcapExactAddress || null,
    items,
  };
}

// Lists embedded in the polled monitored payload stay capped, because they ride
// along on every refresh. The full peer set is only worth paying for when the
// user actually opens the panel, so it lives behind this on-demand lookup.
router.get('/ticker-peers/:address', catalogReadLimiter, async (req, res) => {
  try {
    const address = String(req.params?.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    let identity;
    try {
      identity = createTokenIdentity(req.query?.chain || 'solana', address);
    } catch (_) {
      return res.status(400).json({ error: 'Invalid token chain' });
    }

    const snapshot = await alertTickerPeers.buildTickerPeerSnapshotForAlert(
      { chain: identity.chain, address: identity.address },
      { chain: identity.chain, limit: alertTickerPeers.MAX_PEER_LIST_LIMIT }
    );

    res.json(buildTickerPeerListResponse(identity, snapshot));
  } catch (err) {
    console.error('GET /catalog/ticker-peers/:address error:', err.message);
    res.status(500).json({ error: 'Failed to load ticker peers' });
  }
});

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

      const candidates = await enrichDashboardCandidateMetadata(storedSnapshot.candidates);
      return res.json(buildBidZoneResponse({
        ...storedSnapshot,
        candidates,
      }, { refreshAvailableAt }));
    }

    const candidates = await tokenMarketBucket1m.listBidZoneCandidates({
      ...options,
      limit,
    });
    const enrichedCandidates = await enrichDashboardCandidateMetadata(candidates);
    return res.json(buildBidZoneResponse({
      generatedAt: new Date().toISOString(),
      runId: null,
      requestedHours: options.hours,
      minMcap: options.minMcap,
      minVol1h: options.minVol1h,
      minVol24h: options.minVol24h,
      count: enrichedCandidates.length,
      candidateCount: enrichedCandidates.length,
      resultCount: enrichedCandidates.length,
      candidates: enrichedCandidates,
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

    const candidates = await enrichDashboardCandidateMetadata(snapshot.candidates);

    res.json(buildBidZoneResponse({
      ...snapshot,
      candidates,
    }, {
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

    const rows = await uiMeteoraSummaryCache.listUiSummaryByAddresses(parsed.addresses);
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
