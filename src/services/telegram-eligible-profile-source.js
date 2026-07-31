const candidateModel = require('../models/telegram-alert-evaluation-candidate');
const userAccess = require('../models/user-access');

const DEFAULT_CACHE_TTL_MS = 5_000;

function normalizeNowMs(value, now) {
  const normalized = Number(value ?? now());
  if (!Number.isFinite(normalized)) {
    throw new TypeError('Telegram profile discovery nowMs must be finite');
  }
  return normalized;
}

function normalizeTtlMs(value) {
  if (value === undefined) return DEFAULT_CACHE_TTL_MS;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError('Telegram profile cache TTL must be non-negative');
  }
  return normalized;
}

function createTelegramEligibleProfileSource(options = {}) {
  const repository = options.candidateModel || candidateModel;
  const resolveAccess = options.accessResolver
    || userAccess.buildResolvedAccessSnapshot;
  const now = options.now || Date.now;
  const ttlMs = normalizeTtlMs(options.cacheTtlMs);
  const cache = new Map();
  const inFlight = new Map();

  if (typeof repository.listByChain !== 'function') {
    throw new TypeError('Telegram evaluation candidate model is required');
  }
  if (typeof resolveAccess !== 'function') {
    throw new TypeError('Telegram access resolver is required');
  }

  async function loadCandidates(chain, nowMs) {
    const cached = cache.get(chain);
    if (cached && cached.expiresAt > nowMs) return cached.candidates;
    if (inFlight.has(chain)) return inFlight.get(chain);

    const request = Promise.resolve(repository.listByChain(chain))
      .then((candidates) => {
        if (!Array.isArray(candidates)) {
          throw new TypeError('Telegram evaluation candidates must be an array');
        }
        cache.set(chain, {
          candidates,
          expiresAt: nowMs + ttlMs,
        });
        return candidates;
      })
      .finally(() => {
        inFlight.delete(chain);
      });
    inFlight.set(chain, request);
    return request;
  }

  async function reportAccessError(error, candidate) {
    if (typeof options.onAccessError !== 'function') return;
    try {
      await options.onAccessError({ error, candidate });
    } catch (_) {}
  }

  async function listEligible(input = {}) {
    const nowMs = normalizeNowMs(input.nowMs, now);
    const candidates = await loadCandidates(input.chain, nowMs);
    const eligible = [];

    for (const candidate of candidates) {
      if (candidate?.user?.is_active !== true) continue;
      try {
        const access = await resolveAccess(
          candidate.user,
          new Date(nowMs),
          options.accessDeps || {}
        );
        if (access?.hasProductAccess) {
          eligible.push(Object.freeze({
            profile: candidate.profile,
            rules: candidate.rules,
          }));
        }
      } catch (error) {
        await reportAccessError(error, candidate);
      }
    }
    return Object.freeze(eligible);
  }

  function invalidate(chain) {
    if (chain === undefined) {
      cache.clear();
      return;
    }
    cache.delete(chain);
  }

  return Object.freeze({ invalidate, listEligible });
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  createTelegramEligibleProfileSource,
};
