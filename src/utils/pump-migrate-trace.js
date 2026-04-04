function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1';
}

const TRACE_ENABLED = parseBoolean(process.env.PUMP_MIGRATE_TRACE_ENABLED, false);
const TRACE_DISCOVERY_ENABLED = parseBoolean(process.env.PUMP_MIGRATE_TRACE_DISCOVERY, false);
const TRACE_ADDRESS_FILTER = new Set(
  String(process.env.PUMP_MIGRATE_TRACE_ADDRESSES || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean)
);

function getTokenAddress(payload = {}) {
  const candidates = [
    payload.tokenAddress,
    payload.address,
    payload.mint,
    payload.baseTokenAddress,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) {
      return value;
    }
  }

  return '';
}

function shouldTraceAddress(address) {
  if (!TRACE_ENABLED) {
    return false;
  }

  if (TRACE_ADDRESS_FILTER.size === 0) {
    return true;
  }

  return TRACE_ADDRESS_FILTER.has(String(address || '').trim());
}

function shouldTraceEvent(event, payload = {}) {
  const address = getTokenAddress(payload);
  if (!shouldTraceAddress(address)) {
    return false;
  }

  if (String(event || '').startsWith('dex_discovery_') && !TRACE_DISCOVERY_ENABLED) {
    return false;
  }

  return true;
}

function isTraceDiscoveryEnabled() {
  return TRACE_DISCOVERY_ENABLED;
}

function logTrace(event, payload = {}, options = {}) {
  if (!shouldTraceEvent(event, payload)) {
    return;
  }

  const entry = {
    trace: 'pump-migrate',
    event: String(event || '').trim() || 'unknown',
    ts: new Date().toISOString(),
    ...payload,
  };

  const line = `[PumpMigrateTrace] ${JSON.stringify(entry)}`;
  if (options.level === 'warn') {
    console.warn(line);
    return;
  }

  if (options.level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

module.exports = {
  getTokenAddress,
  isTraceDiscoveryEnabled,
  logTrace,
  shouldTraceAddress,
  traceEnabled: TRACE_ENABLED,
  traceDiscoveryEnabled: TRACE_DISCOVERY_ENABLED,
};
