const config = require('../../config');

function isEnabled() {
  return Boolean(config.performanceMetrics?.enabled);
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function roundMs(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : 0;
}

function estimateJsonBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch (_) {
    return 0;
  }
}

function buildServerTiming(timings = {}) {
  return Object.entries(timings)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => `${name};dur=${roundMs(value)}`)
    .join(', ');
}

function attachResponsePerfHeaders(res, label, payload, timings = {}) {
  if (!isEnabled()) {
    return { responseBytes: 0 };
  }

  const responseBytes = estimateJsonBytes(payload);
  const serverTiming = buildServerTiming(timings);

  if (serverTiming) {
    res.set('Server-Timing', serverTiming);
  }
  res.set('X-Perf-Label', label);
  res.set('X-Perf-Response-Bytes', String(responseBytes));

  return { responseBytes };
}

function logRequestPerf(req, label, metrics = {}) {
  if (!isEnabled()) {
    return;
  }

  const parts = Object.entries(metrics)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (typeof value === 'number') {
        return `${key}=${Number.isInteger(value) ? value : roundMs(value)}`;
      }
      return `${key}=${String(value)}`;
    });

  console.log(`[Perf] ${label} ${req.method} ${req.originalUrl} ${parts.join(' ')}`.trim());
}

module.exports = {
  isEnabled,
  nowMs,
  roundMs,
  estimateJsonBytes,
  attachResponsePerfHeaders,
  logRequestPerf,
};
