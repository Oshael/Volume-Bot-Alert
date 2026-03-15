const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const tokenCatalog = require('../models/token-catalog');
const tokenMarketSnapshot = require('../models/token-market-snapshot');
const userToken = require('../models/user-token');
const dexscreener = require('../services/dexscreener');
const { isValidAddress } = require('../models/user-token');

const MONITORED_MIN_MCAP = 30000;
const TRANSIENT_RETRY_MS = 40000;
const promoteRetryState = new Map();

router.use(authenticate);

router.get('/eligible', async (req, res) => {
  try {
    const tokens = await tokenCatalog.listEligibleVisible(req.query?.limit, req.query?.minMcap);
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
      minMcap: Number.isFinite(Number(req.query?.minMcap)) ? Number(req.query.minMcap) : MONITORED_MIN_MCAP,
    });
  } catch (err) {
    console.error('GET /catalog/eligible error:', err.message);
    res.status(500).json({ error: 'Failed to load eligible catalog tokens' });
  }
});

function buildCatalogTokenPayload(body = {}, fallbackSource = 'unknown') {
  return {
    address: body.address || body.mint || null,
    chain: body.chain || 'solana',
    source: body.source || fallbackSource,
    symbol: body.symbol || null,
    name: body.name || null,
    mcap: body.mcap || null,
    price: body.price || null,
    pairAddress: body.pairAddress || null,
    pairUrl: body.pairUrl || null,
    imageUrl: body.imageUrl || null,
    twitterUrl: body.twitterUrl || null,
    isActiveMonitorCandidate: body.isActiveMonitorCandidate,
  };
}

function normalizeSource(source) {
  return String(source || '').trim().toLowerCase();
}

function extractTwitterUrl(pair) {
  return pair?.info?.socials?.find((item) => item.type === 'twitter')?.url || null;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getMarketCap(pair) {
  return toNumber(pair?.marketCap) || toNumber(pair?.fdv) || 0;
}

function getRetryKey(userId, address, source) {
  return `${userId}:${source}:${address}`;
}

function setTransientRetry(userId, address, source, reason) {
  const retryAt = Date.now() + TRANSIENT_RETRY_MS;
  promoteRetryState.set(getRetryKey(userId, address, source), { retryAt, reason });
  return retryAt;
}

function getTransientRetry(userId, address, source) {
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

async function buildValidatedPromotion(user, body = {}) {
  const requested = buildCatalogTokenPayload(body, 'unknown');
  const address = String(requested.address || '').trim();
  if (!isValidAddress(address)) {
    return { status: 400, error: 'Invalid token address' };
  }

  const source = normalizeSource(requested.source);
  const chain = String(requested.chain || 'solana').trim().toLowerCase();

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
      pairAddress: bestPair.pairAddress || requested.pairAddress,
      pairUrl: bestPair.url || requested.pairUrl,
      imageUrl: bestPair.info?.imageUrl || requested.imageUrl,
      twitterUrl: extractTwitterUrl(bestPair) || requested.twitterUrl,
      isActiveMonitorCandidate: requested.isActiveMonitorCandidate,
    },
  };
}

router.get('/history/:address', async (req, res) => {
  try {
    const address = String(req.params?.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const snapshots = await tokenMarketSnapshot.listHistoryByAddress(address, {
      limit: req.query?.limit,
      hours: req.query?.hours,
      days: req.query?.days,
    });

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

router.post('/promote', async (req, res) => {
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

router.post('/migrated', async (req, res) => {
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
