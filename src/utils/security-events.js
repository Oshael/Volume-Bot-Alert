const MAX_RECENT_EVENTS = 50;
const eventCounts = new Map();
const recentEvents = [];

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
