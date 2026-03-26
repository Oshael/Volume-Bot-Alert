const MAX_RECENT_EVENTS = 50;
const eventCounts = new Map();
const recentEvents = [];
const throttledConsoleEvents = new Map();

function getThrottleWindowMs(payload) {
  if (payload.event === 'rate_limit_exceeded' && payload.limiter === 'pumpfun-meta') {
    return 60000;
  }
  if (payload.event === 'socket_subscription_limit_reached') {
    return 60000;
  }
  return 0;
}

function getThrottleKey(payload) {
  if (payload.event === 'rate_limit_exceeded') {
    return [
      payload.event,
      payload.limiter || 'unknown',
      payload.key || payload.userId || payload.ip || 'unknown',
    ].join('|');
  }
  if (payload.event === 'socket_subscription_limit_reached') {
    return [
      payload.event,
      payload.socketId || payload.sessionId || payload.userId || payload.ip || 'unknown',
      payload.limit || 'unknown',
    ].join('|');
  }
  return null;
}

function sanitizeDetailValue(value) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value).slice(0, 400);
}

function logSecurityEvent(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event: String(event || 'unknown'),
  };

  for (const [key, value] of Object.entries(details || {})) {
    payload[key] = sanitizeDetailValue(value);
  }

  eventCounts.set(payload.event, (eventCounts.get(payload.event) || 0) + 1);
  recentEvents.unshift(payload);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.length = MAX_RECENT_EVENTS;
  }

  const throttleKey = getThrottleKey(payload);
  const throttleWindowMs = getThrottleWindowMs(payload);
  if (throttleKey && throttleWindowMs > 0) {
    const now = Date.now();
    const previous = throttledConsoleEvents.get(throttleKey);
    if (previous && now - previous.lastLoggedAt < throttleWindowMs) {
      previous.suppressedCount += 1;
      previous.lastSeenAt = now;
      throttledConsoleEvents.set(throttleKey, previous);
      return;
    }

    const suppressedSinceLastLog = previous?.suppressedCount || 0;
    throttledConsoleEvents.set(throttleKey, {
      lastLoggedAt: now,
      lastSeenAt: now,
      suppressedCount: 0,
    });

    if (suppressedSinceLastLog > 0) {
      payload.suppressedSinceLastLog = suppressedSinceLastLog;
    }
  }

  console.warn(`[Security] ${JSON.stringify(payload)}`);
}

function getSecurityEventStats() {
  return {
    total: Array.from(eventCounts.values()).reduce((sum, count) => sum + count, 0),
    counts: Object.fromEntries(Array.from(eventCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    recent: recentEvents.slice(0, MAX_RECENT_EVENTS),
  };
}

module.exports = {
  logSecurityEvent,
  getSecurityEventStats,
};
