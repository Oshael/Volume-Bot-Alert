const dexscreener = require('./dexscreener');
const robinhoodCatalog = require('../models/robinhood-catalog');
const { extractTokenProfileSocialLinks } = require('../utils/dex-social-links');
const { sanitizeAssetUrl } = require('../utils/url-safety');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_PENDING_TTL_MS = 30 * 60_000;
const DEFAULT_PENDING_MAX = 500;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function normalizeAddress(value) {
  try {
    return normalizeTokenAddress(CHAIN, value);
  } catch (_) {
    return null;
  }
}

// The Token Profiles feed is global and returns the most recent profiles across
// every chain. We keep only Robinhood items and reduce them to the smallest
// shape the sync needs: a safe icon plus the raw links array for later
// classification. Duplicate addresses keep the most recent occurrence.
function collectRobinhoodProfiles(items) {
  const list = Array.isArray(items) ? items : [];
  const byAddress = new Map();
  let robinhood = 0;
  let invalid = 0;
  for (const item of list) {
    if (String(item?.chainId || '').trim().toLowerCase() !== CHAIN) continue;
    robinhood += 1;
    const address = normalizeAddress(item?.tokenAddress);
    if (!address) {
      invalid += 1;
      continue;
    }
    byAddress.set(address, {
      icon: sanitizeAssetUrl(item?.icon),
      links: Array.isArray(item?.links) ? item.links : [],
    });
  }
  return { byAddress, received: list.length, robinhood, invalid };
}

// The pending map only exists to cover the race where a profile arrives before
// the on-chain pipeline has created the catalog row or tried the durable image
// sources. It is bounded and expires quickly; it is never a history guarantee.
function createPendingStore(now, ttlMs, maxEntries) {
  const entries = new Map();
  return {
    prune() {
      const cutoff = now();
      for (const [address, entry] of entries) {
        if (entry.expiresAtMs <= cutoff) entries.delete(address);
      }
    },
    keep(address, candidate) {
      if (!entries.has(address) && entries.size >= maxEntries) return;
      entries.set(address, { ...candidate, expiresAtMs: now() + ttlMs });
    },
    drop(address) {
      entries.delete(address);
    },
    snapshot() {
      return new Map([...entries].map(([address, entry]) => [address, {
        icon: entry.icon, links: entry.links,
      }]));
    },
    get size() {
      return entries.size;
    },
  };
}

// Pure decision for a single candidate given its current catalog row. The
// DexScreener profile is the source of truth for the image and may overwrite an
// existing one, but only after the on-chain pipeline has been tried
// (robinhood_blockscout_checked_at) and never for an unchanged icon, so the feed
// re-emitting the same profile every minute does not churn the row.
function classifyCandidate(row, candidate) {
  if (!row) return 'missing-catalog';
  if (!row.robinhood_blockscout_checked_at) return 'priority';
  if (!candidate.icon) return 'invalid';
  if (row.last_image_url === candidate.icon) return 'existing';
  return 'write';
}

function createRobinhoodDexscreenerProfileSync(options = {}) {
  const dexClient = options.dexClient || dexscreener;
  if (typeof dexClient.getLatestTokenProfiles !== 'function') {
    throw new Error('DexScreener getLatestTokenProfiles is required');
  }
  const catalog = options.catalog || robinhoodCatalog;
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const socialMetadataEnabled = options.socialMetadataEnabled === true;
  const intervalMs = boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 60_000, 60 * 60_000);
  const pendingTtlMs = boundedInteger(
    options.pendingTtlMs, DEFAULT_PENDING_TTL_MS, 60_000, 24 * 60 * 60_000,
  );
  const pendingMax = boundedInteger(options.pendingMax, DEFAULT_PENDING_MAX, 1, 5000);
  const pending = createPendingStore(now, pendingTtlMs, pendingMax);
  let lastFetchAtMs = null;
  let lastSuccessAt = null;
  let started = false;

  function baseSummary(status, extra = {}) {
    return {
      status,
      received: 0,
      robinhood: 0,
      valid: 0,
      resolvedImages: 0,
      existingImages: 0,
      pending: pending.size,
      skippedMissingCatalog: 0,
      skippedPriorityPending: 0,
      invalid: 0,
      errors: 0,
      lastSuccessAt,
      ...extra,
    };
  }

  function socialFields(links) {
    if (!socialMetadataEnabled) return {};
    const social = extractTokenProfileSocialLinks(links);
    return {
      websiteUrl: social.websiteUrl,
      twitterUrl: social.twitterUrl,
      communityUrl: social.communityUrl,
      telegramUrl: social.telegramUrl,
    };
  }

  async function persistImage(address, candidate, summary) {
    try {
      await catalog.recordDexscreenerMetadata({
        address,
        imageUrl: candidate.icon,
        overwriteImage: true,
        ...socialFields(candidate.links),
      });
      summary.resolvedImages += 1;
      pending.drop(address);
    } catch (error) {
      summary.errors += 1;
      summary.status = 'error';
      pending.keep(address, candidate);
      logger.warn?.(`[RobinhoodDexProfileSync] persist error ${address}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }

  async function resolveCandidates(candidates, metadataByAddress, summary) {
    for (const [address, candidate] of candidates) {
      const decision = classifyCandidate(metadataByAddress.get(address), candidate);
      if (decision === 'missing-catalog') {
        summary.skippedMissingCatalog += 1;
        pending.keep(address, candidate);
      } else if (decision === 'existing') {
        summary.existingImages += 1;
        pending.drop(address);
      } else if (decision === 'priority') {
        summary.skippedPriorityPending += 1;
        pending.keep(address, candidate);
      } else if (decision === 'invalid') {
        // No safe icon: nothing durable to persist, and we must not stamp
        // robinhood_dexscreener_checked_at or the by-address fallback is blocked.
        summary.invalid += 1;
        pending.drop(address);
      } else {
        await persistImage(address, candidate, summary);
      }
    }
  }

  function logStartOnce() {
    if (started) return;
    started = true;
    logger.log?.(
      `[RobinhoodDexProfileSync] enabled interval=${intervalMs}ms `
      + `pendingTtl=${pendingTtlMs}ms pendingMax=${pendingMax}`,
    );
  }

  async function fetchProfiles() {
    try {
      lastFetchAtMs = now();
      return { ok: true, profiles: await dexClient.getLatestTokenProfiles() };
    } catch (error) {
      logger.warn?.(`[RobinhoodDexProfileSync] feed error: ${String(error?.message || error).slice(0, 200)}`);
      return { ok: false };
    }
  }

  async function loadMetadataRows(addresses) {
    try {
      return { ok: true, rows: await catalog.listMetadata(addresses) };
    } catch (error) {
      logger.warn?.(`[RobinhoodDexProfileSync] listMetadata error: ${String(error?.message || error).slice(0, 200)}`);
      return { ok: false };
    }
  }

  function markSuccess(summary) {
    lastSuccessAt = new Date(now()).toISOString();
    summary.lastSuccessAt = lastSuccessAt;
    summary.pending = pending.size;
    return summary;
  }

  async function runOnce() {
    logStartOnce();
    const throttle = dexClient.getThrottleState?.(now());
    if (throttle?.pauseDiscovery) return baseSummary('paused');
    if (lastFetchAtMs != null && lastFetchAtMs + intervalMs > now()) {
      return baseSummary('cooldown');
    }

    const fetched = await fetchProfiles();
    if (!fetched.ok) return baseSummary('error', { errors: 1 });

    const feed = collectRobinhoodProfiles(fetched.profiles);
    pending.prune();
    const candidates = pending.snapshot();
    for (const [address, candidate] of feed.byAddress) candidates.set(address, candidate);

    const summary = baseSummary('ok', {
      received: feed.received,
      robinhood: feed.robinhood,
      valid: feed.byAddress.size,
      invalid: feed.invalid,
    });
    if (!candidates.size) return markSuccess(summary);

    const loaded = await loadMetadataRows([...candidates.keys()]);
    if (!loaded.ok) {
      summary.status = 'error';
      summary.errors += 1;
      summary.pending = pending.size;
      return summary;
    }
    const metadataByAddress = new Map(loaded.rows.map((row) => [row.address, row]));
    await resolveCandidates(candidates, metadataByAddress, summary);

    if (summary.status === 'error') {
      summary.pending = pending.size;
      return summary;
    }
    return markSuccess(summary);
  }

  function snapshot() {
    return {
      pending: pending.size,
      intervalMs,
      pendingTtlMs,
      pendingMax,
      lastFetchAtMs,
      lastSuccessAt,
      socialMetadataEnabled,
    };
  }

  return Object.freeze({ runOnce, snapshot });
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_PENDING_TTL_MS,
  DEFAULT_PENDING_MAX,
  createRobinhoodDexscreenerProfileSync,
  __private: { collectRobinhoodProfiles, createPendingStore, normalizeAddress },
};
