'use strict';

// Bloco 3, slice 3.3: session pool. Hands the worker a usable session per cycle,
// rotates across sessions (least-recently-used), tracks a token bucket per
// (session, endpoint) from the real rate-limit headers, quarantines a session on
// 401/403, and persists a rotated ct0. Purely in-memory over the x_session model.

const xSessionModel = require('../models/x-session');

const DEFAULT_QUARANTINE_MS = 15 * 60_000;

function createSessionPool(options = {}) {
  const model = options.model || xSessionModel;
  const now = options.now || Date.now;
  const quarantineMs = options.quarantineMs || DEFAULT_QUARANTINE_MS;

  let sessions = [];
  const buckets = new Map(); // `${id}:${endpoint}` -> { remaining, resetMs }
  const lastAcquired = new Map(); // id -> ms

  const bucketKey = (id, endpoint) => `${id}:${endpoint}`;

  async function refresh() {
    sessions = await model.listActive({ now });
    return sessions.length;
  }

  function hasBudget(id, endpoint) {
    const bucket = buckets.get(bucketKey(id, endpoint));
    if (!bucket) return true; // unknown budget -> allow, learn from headers
    if (bucket.resetMs != null && now() >= bucket.resetMs) return true; // window rolled over
    return bucket.remaining == null || bucket.remaining > 0;
  }

  function acquire(endpoint) {
    const session = sessions
      .filter((s) => hasBudget(s.id, endpoint))
      .sort((a, b) => (lastAcquired.get(a.id) || 0) - (lastAcquired.get(b.id) || 0))[0];
    if (!session) return null;
    lastAcquired.set(session.id, now());
    const bucket = buckets.get(bucketKey(session.id, endpoint));
    if (bucket && bucket.remaining != null && bucket.remaining > 0) bucket.remaining -= 1; // optimistic
    return session;
  }

  async function report(session, endpoint, result = {}) {
    if (result.status === 401 || result.status === 403) {
      await model.quarantine(session.id, now() + quarantineMs);
      sessions = sessions.filter((s) => s.id !== session.id);
      return;
    }
    if (result.rateLimit) {
      buckets.set(bucketKey(session.id, endpoint), {
        remaining: result.rateLimit.remaining,
        resetMs: result.rateLimit.resetMs,
      });
    }
    if (result.newCt0) {
      session.ct0 = result.newCt0;
      await model.updateCt0(session.id, result.newCt0);
    }
    await model.markUsed(session.id, { now });
  }

  return { refresh, acquire, report, size: () => sessions.length };
}

module.exports = { createSessionPool };
