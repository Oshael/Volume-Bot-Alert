const { normalizeTokenChain } = require('../utils/token-identity');

const SPOT_WINDOW = 'spot';
const ERROR_CODES = Object.freeze({
  chainUnsupported: 'CUSTOM_ALERT_CHAIN_UNSUPPORTED',
  metricUnsupported: 'CUSTOM_ALERT_METRIC_UNSUPPORTED',
  windowUnsupported: 'CUSTOM_ALERT_WINDOW_UNSUPPORTED',
  notReady: 'CUSTOM_ALERT_NOT_READY',
});

const CAPABILITY_MATRIX = Object.freeze({
  solana: Object.freeze({
    metrics: Object.freeze(['price', 'mcap']),
    windows: Object.freeze([SPOT_WINDOW]),
  }),
  robinhood: Object.freeze({
    metrics: Object.freeze(['price', 'fdv']),
    windows: Object.freeze([SPOT_WINDOW]),
  }),
});

function normalizeChain(value) {
  try {
    return normalizeTokenChain(value);
  } catch (_) {
    return null;
  }
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getCustomAlertCapability(input = {}) {
  const chain = normalizeChain(input.chain);
  const definition = chain ? CAPABILITY_MATRIX[chain] : null;
  if (!definition) {
    return Object.freeze({
      chain,
      supported: false,
      ready: false,
      metrics: Object.freeze([]),
      windows: Object.freeze([]),
      reason: 'unsupported_chain',
    });
  }

  const ready = input.ready === true;
  return Object.freeze({
    chain,
    supported: true,
    ready,
    metrics: definition.metrics,
    windows: definition.windows,
    reason: ready ? null : normalizeName(input.reason) || 'capability_not_ready',
  });
}

function rejected(capability, code, reason, metric, window, legacyWindowDefaulted) {
  return Object.freeze({
    ok: false,
    code,
    reason,
    capability,
    chain: capability.chain,
    metric: metric || null,
    window,
    legacyWindowDefaulted,
  });
}

function evaluateCustomAlertCapability(input = {}) {
  const capability = getCustomAlertCapability(input);
  const metric = normalizeName(input.metric);
  const requestedWindow = normalizeName(input.window);
  const legacyWindowDefaulted = !requestedWindow;
  const window = requestedWindow || SPOT_WINDOW;

  if (!capability.supported) {
    return rejected(
      capability, ERROR_CODES.chainUnsupported, 'unsupported_chain',
      metric, window, legacyWindowDefaulted,
    );
  }
  if (!capability.metrics.includes(metric)) {
    return rejected(
      capability, ERROR_CODES.metricUnsupported, 'unsupported_metric',
      metric, window, legacyWindowDefaulted,
    );
  }
  if (!capability.windows.includes(window)) {
    return rejected(
      capability, ERROR_CODES.windowUnsupported, 'unsupported_window',
      metric, window, legacyWindowDefaulted,
    );
  }
  if (!capability.ready) {
    return rejected(
      capability, ERROR_CODES.notReady, capability.reason,
      metric, window, legacyWindowDefaulted,
    );
  }

  return Object.freeze({
    ok: true,
    code: null,
    reason: null,
    capability,
    chain: capability.chain,
    metric,
    window,
    legacyWindowDefaulted,
  });
}

module.exports = {
  CAPABILITY_MATRIX,
  ERROR_CODES,
  SPOT_WINDOW,
  evaluateCustomAlertCapability,
  getCustomAlertCapability,
};
