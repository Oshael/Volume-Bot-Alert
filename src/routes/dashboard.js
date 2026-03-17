const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const tokenMarketSnapshot = require('../models/token-market-snapshot');

const MONITORED_MIN_MCAP = 30000;
const MCAP_DELTA_WINDOW_MS = 5 * 60 * 1000;
const METEORA_DELTA_1H_MS = 60 * 60 * 1000;
const METEORA_DELTA_6H_MS = 6 * 60 * 60 * 1000;
const METEORA_DELTA_24H_MS = 24 * 60 * 60 * 1000;

router.use(authenticate);

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

function buildMarketBaseline(latestRows) {
  const validRows = latestRows.filter((row) => row?.mcap != null && Number.isFinite(Number(row.mcap)));
  const current = validRows[0] || null;
  const currentTs = toDateOrNull(current?.ts)?.getTime() || null;
  const targetTs = currentTs == null ? null : currentTs - MCAP_DELTA_WINDOW_MS;
  let previous = null;

  if (targetTs != null) {
    previous = validRows.find((row) => {
      if (row === current) return false;
      const rowTs = toDateOrNull(row.ts)?.getTime();
      return rowTs != null && rowTs <= targetTs;
    }) || null;
  }

  if (!previous && validRows.length > 1) {
    previous = validRows[validRows.length - 1];
  }

  const currentMcap = current?.mcap == null ? null : Number(current.mcap);
  const previousMcap = previous?.mcap == null ? null : Number(previous.mcap);
  const mcapDelta = currentMcap != null && previousMcap != null && previousMcap > 0
    ? ((currentMcap - previousMcap) / previousMcap) * 100
    : null;

  return {
    prevMcap: Number.isFinite(previousMcap) ? previousMcap : null,
    mcapDelta: Number.isFinite(mcapDelta) ? mcapDelta : null,
  };
}

router.get('/monitored', async (req, res) => {
  try {
    const tokens = await tokenCatalog.listDashboardMonitored(req.query?.limit, req.query?.minMcap);
    const addresses = tokens.map((item) => item.address);
    const historyRows = await tokenMeteoraSnapshot.listHistoryByAddresses(addresses, { hours: 30 });
    const marketRows = await tokenMarketSnapshot.listLatestByAddresses(addresses, 60);
    const meteoraByAddress = new Map();
    const marketByAddress = new Map();

    for (const row of historyRows) {
      const current = meteoraByAddress.get(row.token_address) || [];
      current.push(row);
      meteoraByAddress.set(row.token_address, current);
    }

    for (const row of marketRows) {
      const current = marketByAddress.get(row.token_address) || [];
      current.push(row);
      marketByAddress.set(row.token_address, current);
    }

    res.json({
      generatedAt: new Date().toISOString(),
      source: 'token_catalog',
      minMcap: Number.isFinite(Number(req.query?.minMcap)) ? Number(req.query.minMcap) : MONITORED_MIN_MCAP,
      count: tokens.length,
      tokens: tokens.map((item) => {
        const marketBaseline = buildMarketBaseline(marketByAddress.get(item.address) || []);
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
        lastSeenAt: item.last_seen_at || null,
        lastEvaluatedAt: item.last_evaluated_at || null,
        meteora: buildMeteoraSummary(item.address, meteoraByAddress.get(item.address) || []),
      };
      }),
    });
  } catch (err) {
    console.error('GET /dashboard/monitored error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored dashboard' });
  }
});

module.exports = router;
