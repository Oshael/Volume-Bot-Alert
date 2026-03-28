const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/rate-limit');
const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const tokenMarketSnapshot = require('../models/token-market-snapshot');

const MONITORED_MIN_MCAP = 30000;

function normalizeMinMcap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MONITORED_MIN_MCAP;
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
      lastSnapshotAt: null,
      change1h: null,
      change6h: null,
      change24h: null,
      noPool: true,
    };
  }

  const latestTvl = Number(summaryRow.current_tvl);
  return {
    address,
    tvl: Number.isFinite(latestTvl) ? latestTvl : null,
    poolAddress: summaryRow.best_pool_address || null,
    poolCount: Number(summaryRow.pool_count) || 0,
    lastSnapshotAt: summaryRow.current_ts || null,
    change1h: computePctChange(summaryRow.current_tvl, summaryRow.baseline_tvl_1h),
    change6h: computePctChange(summaryRow.current_tvl, summaryRow.baseline_tvl_6h),
    change24h: computePctChange(summaryRow.current_tvl, summaryRow.baseline_tvl_24h),
    noPool: false,
  };
}

function buildMarketBaseline(baselineRow) {
  const currentMcap = baselineRow?.current_mcap == null ? null : Number(baselineRow.current_mcap);
  const previousMcap = baselineRow?.baseline_mcap == null ? null : Number(baselineRow.baseline_mcap);
  const previousVolume5m = baselineRow?.baseline_vol_5m == null ? null : Number(baselineRow.baseline_vol_5m);
  const mcapDelta = currentMcap != null && previousMcap != null && previousMcap > 0
    ? ((currentMcap - previousMcap) / previousMcap) * 100
    : null;

  return {
    prevMcap: Number.isFinite(previousMcap) ? previousMcap : null,
    mcapDelta: Number.isFinite(mcapDelta) ? mcapDelta : null,
    prevVolume5mCanonical: Number.isFinite(previousVolume5m) ? previousVolume5m : null,
  };
}

function selectPreferredMarketBaseline(primaryRow, fallbackRow) {
  if (!primaryRow && !fallbackRow) {
    return null;
  }

  const primaryHasMcapBaseline = primaryRow?.baseline_mcap != null;
  const mcapRow = primaryHasMcapBaseline ? primaryRow : (fallbackRow || primaryRow || null);

  return {
    token_address: mcapRow?.token_address ?? primaryRow?.token_address ?? fallbackRow?.token_address ?? null,
    current_ts: mcapRow?.current_ts ?? primaryRow?.current_ts ?? fallbackRow?.current_ts ?? null,
    current_mcap: mcapRow?.current_mcap ?? primaryRow?.current_mcap ?? fallbackRow?.current_mcap ?? null,
    baseline_ts: mcapRow?.baseline_ts ?? primaryRow?.baseline_ts ?? fallbackRow?.baseline_ts ?? null,
    baseline_mcap: mcapRow?.baseline_mcap ?? null,
    current_vol_5m: primaryRow?.current_vol_5m ?? fallbackRow?.current_vol_5m ?? null,
    baseline_vol_5m: primaryRow?.baseline_vol_5m ?? fallbackRow?.baseline_vol_5m ?? null,
  };
}

router.get('/monitored', dashboardLimiter, async (req, res) => {
  try {
    const minMcap = normalizeMinMcap(req.query?.minMcap);
    const tokens = await tokenCatalog.listDashboardMonitored(req.query?.limit, minMcap);
    const addresses = tokens.map((item) => item.address);
    const meteoraSummaryRows = await tokenMeteoraSnapshot.listLatestSummaryByAddresses(addresses);
    const meteoraByAddress = new Map();
    const marketBaselineByAddress = new Map();

    for (const row of meteoraSummaryRows) {
      meteoraByAddress.set(row.token_address, row);
    }

    const [primaryMarketBaselineRows, fallbackMarketBaselineRows] = await Promise.all([
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses(addresses, 5),
      tokenMarketSnapshot.listCurrentAndBaselineByAddresses(addresses, 5),
    ]);

    for (const row of primaryMarketBaselineRows) {
      marketBaselineByAddress.set(row.token_address, row);
    }

    for (const row of fallbackMarketBaselineRows) {
      const existing = marketBaselineByAddress.get(row.token_address) || null;
      marketBaselineByAddress.set(row.token_address, selectPreferredMarketBaseline(existing, row));
    }

    const responsePayload = {
      generatedAt: new Date().toISOString(),
      source: 'token_catalog',
      minMcap,
      count: tokens.length,
      tokens: tokens.map((item) => {
        const marketBaseline = buildMarketBaseline(marketBaselineByAddress.get(item.address) || null);
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
        mcap: item.last_mcap == null ? null : Number(item.last_mcap),
        priceUsd: item.last_price == null ? null : Number(item.last_price),
        volume5m: item.last_vol_5m == null ? null : Number(item.last_vol_5m),
        volume1h: item.last_vol_1h == null ? null : Number(item.last_vol_1h),
        volume6h: item.last_vol_6h == null ? null : Number(item.last_vol_6h),
        volume24h: item.last_vol_24h == null ? null : Number(item.last_vol_24h),
        priceChange1h: item.last_price_change_1h == null ? null : Number(item.last_price_change_1h),
        priceChange6h: item.last_price_change_6h == null ? null : Number(item.last_price_change_6h),
        priceChange24h: item.last_price_change_24h == null ? null : Number(item.last_price_change_24h),
        tokenCreatedAt: item.last_token_created_at_ms == null ? null : Number(item.last_token_created_at_ms),
        prevMcap: marketBaseline.prevMcap,
        mcapDelta: marketBaseline.mcapDelta,
        prevVolume5mCanonical: marketBaseline.prevVolume5mCanonical,
        lastSeenAt: item.last_seen_at || null,
        lastEvaluatedAt: item.last_evaluated_at || null,
        meteora: buildMeteoraSummary(item.address, meteoraByAddress.get(item.address) || null),
      };
      }),
    };
    res.json(responsePayload);
  } catch (err) {
    console.error('GET /dashboard/monitored error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored dashboard' });
  }
});

router.__private = {
  selectPreferredMarketBaseline,
};

module.exports = router;
