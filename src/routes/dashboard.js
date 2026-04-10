const express = require('express');
const router = express.Router();
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const tokenMeteoraState = require('../models/token-meteora-state');
const backendAlertFeed = require('../services/backend-alert-feed');
const { classifyTokenJunk } = require('../services/token-junk-metric');
const {
  buildBlockStatusSummary,
  buildEffectiveRiskLabel,
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
  toNumberOrNull,
} = require('../services/token-risk-summary');

const MONITORED_MIN_MCAP = 30000;

function normalizeMinMcap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_MCAP;
}

function parseOptionalEventId(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: undefined };
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `${name} must be a positive integer` };
  }

  return { ok: true, value: parsed };
}

router.use(authenticate);

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
    change1h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl1h) : null,
    change6h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl6h) : null,
    change24h: hasPool ? computePctChange(summaryRow.currentTvl, summaryRow.baselineTvl24h) : null,
    noPool: !hasPool,
  };
}

function buildMarketBaseline(mcapBaselineRow, volumeBaselineRow) {
  const currentMcap = toNumberOrNull(mcapBaselineRow?.current_mcap);
  const previousMcap = toNumberOrNull(mcapBaselineRow?.baseline_mcap);
  const previousVolume5m = toNumberOrNull(volumeBaselineRow?.baseline_vol_5m);
  const mcapDelta = currentMcap != null && previousMcap != null && previousMcap > 0
    ? ((currentMcap - previousMcap) / previousMcap) * 100
    : null;

  return {
    prevMcap: Number.isFinite(previousMcap) ? previousMcap : null,
    mcapDelta: Number.isFinite(mcapDelta) ? mcapDelta : null,
    prevVolume5mCanonical: Number.isFinite(previousVolume5m) ? previousVolume5m : null,
  };
}

function buildMonitoredTokenPayload(item, meteoraByAddress, marketMcapBaselineByAddress, marketVolumeBaselineByAddress) {
  const marketBaseline = buildMarketBaseline(
    marketMcapBaselineByAddress.get(item.address) || null,
    marketVolumeBaselineByAddress.get(item.address) || null
  );
  const meteora = buildMeteoraSummary(item.address, meteoraByAddress.get(item.address) || null);

  return {
    address: item.address,
    symbol: item.symbol || null,
    name: item.name || null,
    pairAddress: item.last_pair_address || null,
    pairUrl: item.last_pair_url || null,
    imageUrl: item.last_image_url || null,
    twitterUrl: item.last_twitter_url || null,
    eligibleForMonitoring: Boolean(item.eligible_for_monitoring),
    monitorPriority: item.monitor_priority || 'dormant',
    mcap: toNumberOrNull(item.last_mcap),
    priceUsd: toNumberOrNull(item.last_price),
    volume5m: toNumberOrNull(item.last_vol_5m),
    volume1h: toNumberOrNull(item.last_vol_1h),
    volume6h: toNumberOrNull(item.last_vol_6h),
    volume24h: toNumberOrNull(item.last_vol_24h),
    priceChange1h: toNumberOrNull(item.last_price_change_1h),
    priceChange6h: toNumberOrNull(item.last_price_change_6h),
    priceChange24h: toNumberOrNull(item.last_price_change_24h),
    tokenCreatedAt: toNumberOrNull(item.last_token_created_at_ms),
    prevMcap: marketBaseline.prevMcap,
    mcapDelta: marketBaseline.mcapDelta,
    prevVolume5mCanonical: marketBaseline.prevVolume5mCanonical,
    lastSeenAt: item.last_seen_at || null,
    lastEvaluatedAt: item.last_evaluated_at || null,
    blockStatus: buildBlockStatusSummary(item),
    effectiveRiskLabel: buildEffectiveRiskLabel(item),
    riskReview: buildRiskReviewSummary(item),
    structuralRisk: buildStructuralRiskSummary(item),
    junkAssessment: classifyTokenJunk({
      ...item,
      meteora,
    }),
    meteora,
  };
}

router.get('/monitored', dashboardLimiter, async (req, res) => {
  try {
    const minMcap = normalizeMinMcap(req.query?.minMcap);
    const tokens = await tokenCatalog.listDashboardMonitored(req.query?.limit, minMcap);
    const addresses = tokens.map((item) => item.address);
    const meteoraSummaryRows = await tokenMeteoraState.listSummaryByAddresses(addresses);
    const meteoraByAddress = new Map();
    const marketMcapBaselineByAddress = new Map();
    const marketVolumeBaselineByAddress = new Map();

    for (const row of meteoraSummaryRows) {
      meteoraByAddress.set(row.tokenAddress, row);
    }

    const [primaryMarketBaselineRows, primaryVolumeBaselineRows] = await Promise.all([
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
    ]);

    for (const row of primaryMarketBaselineRows) {
      marketMcapBaselineByAddress.set(row.token_address, row);
    }

    for (const row of primaryVolumeBaselineRows) {
      marketVolumeBaselineByAddress.set(row.token_address, row);
    }

    const responsePayload = {
      generatedAt: new Date().toISOString(),
      source: 'token_catalog',
      minMcap,
      count: tokens.length,
      tokens: tokens.map((item) => buildMonitoredTokenPayload(
        item,
        meteoraByAddress,
        marketMcapBaselineByAddress,
        marketVolumeBaselineByAddress
      )),
    };
    res.json(responsePayload);
  } catch (err) {
    console.error('GET /dashboard/monitored error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored dashboard' });
  }
});

router.get('/alert-events', dashboardLimiter, async (req, res) => {
  const afterId = parseOptionalEventId(req.query?.afterId, 'afterId');
  if (!afterId.ok) {
    return res.status(400).json({ error: afterId.error });
  }

  try {
    const payload = await backendAlertFeed.listDashboardAlertEvents({
      userId: req.user.id,
      ruleKey: req.query?.ruleKey,
      limit: req.query?.limit,
      mode: req.query?.mode,
      afterId: afterId.value,
    });
    res.json(payload);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    console.error('GET /dashboard/alert-events error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard alert events' });
  }
});

router.post('/alert-events/cursor', dashboardLimiter, requireTrustedOrigin, async (req, res) => {
  const lastSeenEventId = parseOptionalEventId(req.body?.lastSeenEventId, 'lastSeenEventId');
  if (!lastSeenEventId.ok) {
    return res.status(400).json({ error: lastSeenEventId.error });
  }

  const lastAckedEventId = parseOptionalEventId(req.body?.lastAckedEventId, 'lastAckedEventId');
  if (!lastAckedEventId.ok) {
    return res.status(400).json({ error: lastAckedEventId.error });
  }

  if (lastSeenEventId.value == null && lastAckedEventId.value == null) {
    return res.status(400).json({ error: 'lastSeenEventId or lastAckedEventId is required' });
  }

  try {
    const cursor = await backendAlertFeed.updateDashboardAlertCursor(req.user.id, {
      ruleKey: req.body?.ruleKey,
      lastSeenEventId: lastSeenEventId.value,
      lastAckedEventId: lastAckedEventId.value,
    });

    res.json({ cursor });
  } catch (err) {
    if (err.code === 'UNSUPPORTED_ALERT_RULE') {
      res.status(400).json({ error: 'Unsupported dashboard alert rule key' });
      return;
    }
    console.error('POST /dashboard/alert-events/cursor error:', err.message);
    res.status(500).json({ error: 'Failed to update dashboard alert cursor' });
  }
});

router.__private = {
  buildMeteoraSummary,
  buildMarketBaseline,
  buildMonitoredTokenPayload,
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
  parseOptionalEventId,
};

module.exports = router;
