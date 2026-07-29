const config = require('../../config');
const { normalizeXHandle } = require('../utils/x-handle');
const { normalizeXProfile } = require('../utils/x-profile-normalize');

const DEFAULT_BASE_URL = 'https://api.fxtwitter.com';

function createXProfileCardService(options = {}) {
  const settings = config.xProfileCard || {};
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = (options.baseUrl || settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const ttlMs = Math.max(60_000, Number(options.ttlMs ?? settings.ttlMs) || 60 * 60_000);
  const negativeTtlMs = Math.max(ttlMs, Number(options.negativeTtlMs ?? settings.negativeTtlMs) || 6 * 60 * 60_000);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? settings.timeoutMs) || 6_000);
  const maxEntries = Math.max(50, Number(options.maxEntries ?? settings.maxEntries) || 2000);

  const entries = new Map();
  const inFlight = new Map();
  const metrics = { hits: 0, misses: 0, fetched: 0, notFound: 0, errors: 0, stale: 0, evicted: 0 };

  function remember(handle, entry) {
    if (!entries.has(handle) && entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      metrics.evicted += 1;
    }
    entries.set(handle, entry);
    return entry;
  }

  async function requestProfile(handle) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(handle)}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        redirect: 'manual',
      });

      if (response.status === 404) {
        return { status: 'not_found' };
      }
      if (!response.ok) {
        throw new Error(`x-profile upstream responded ${response.status}`);
      }

      const profile = normalizeXProfile(await response.json(), now());
      return profile ? { status: 'ok', profile } : { status: 'not_found' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(handle, previous) {
    try {
      const result = await requestProfile(handle);
      metrics.fetched += 1;
      if (result.status === 'not_found') {
        metrics.notFound += 1;
        return remember(handle, { status: 'not_found', profile: null, expiresAtMs: now() + negativeTtlMs });
      }
      return remember(handle, {
        status: 'ok',
        profile: result.profile,
        fetchedAtMs: now(),
        expiresAtMs: now() + ttlMs,
      });
    } catch (error) {
      metrics.errors += 1;
      // A dead upstream degrades the card to stale data instead of blanking it.
      if (previous?.status === 'ok') {
        metrics.stale += 1;
        return { ...previous, stale: true };
      }
      return { status: 'unavailable', profile: null, reason: error.message };
    }
  }

  async function get(rawHandle) {
    const handle = normalizeXHandle(rawHandle);
    if (!handle) {
      return { status: 'invalid', profile: null };
    }

    const cached = entries.get(handle);
    if (cached && cached.expiresAtMs > now()) {
      metrics.hits += 1;
      return { ...cached, cached: true };
    }
    metrics.misses += 1;

    // Hovering the same card repeatedly must not fan out into parallel fetches.
    if (inFlight.has(handle)) {
      return inFlight.get(handle);
    }
    const pending = refresh(handle, cached).finally(() => inFlight.delete(handle));
    inFlight.set(handle, pending);
    return pending;
  }

  return Object.freeze({
    get,
    getMetrics: () => ({ ...metrics, size: entries.size }),
    clear: () => { entries.clear(); inFlight.clear(); },
  });
}

module.exports = {
  createXProfileCardService,
  DEFAULT_BASE_URL,
};
