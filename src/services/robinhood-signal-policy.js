const { normalizeTokenAddress } = require('../utils/token-identity');
const { parseDecimal, ROBINHOOD_USDG, ROBINHOOD_WETH } = require('./evm-market-metrics');
const { classifyTokenEligibility } = require('./robinhood-market-policy');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const AGGREGATE_PROTOCOLS = Object.freeze([...PROTOCOLS]);
const MINUTE_MS = 60 * 1000;
const MAX_WINDOW_MS = 14 * 24 * 60 * MINUTE_MS;
const HVNC_MAX_AGE_MS = 5 * MINUTE_MS;
const CONFIG_FIELDS = Object.freeze([
  'windowMs',
  'minVolumeUsd',
  'minTransactions',
  'maxAgeMs',
]);

function normalizeProtocols(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  const protocols = [...new Set(entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  const unsupported = protocols.filter((protocol) => !PROTOCOLS.has(protocol));
  if (unsupported.length) {
    throw new Error(`unsupported Robinhood signal protocols: ${unsupported.join(', ')}`);
  }
  return Object.freeze(protocols);
}

function optionalSafeInteger(value, label, allowZero = false) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  }
  return parsed;
}

function optionalDecimal(value, label) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = parseDecimal(value, label);
  if (parsed.numerator < 0n) throw new Error(`${label} must be non-negative`);
  return String(value).trim();
}

function optionalWindowMs(value) {
  const windowMs = optionalSafeInteger(value, 'windowMs');
  if (windowMs != null && (windowMs % MINUTE_MS !== 0 || windowMs > MAX_WINDOW_MS)) {
    throw new Error('windowMs must be a whole minute between 1 minute and 14 days');
  }
  return windowMs;
}

function optionalMaxAgeMs(value) {
  const maxAgeMs = optionalSafeInteger(value, 'maxAgeMs');
  if (maxAgeMs != null && maxAgeMs > HVNC_MAX_AGE_MS) {
    throw new Error(`maxAgeMs must be at most ${HVNC_MAX_AGE_MS} for Robinhood HVNC`);
  }
  return maxAgeMs;
}

function normalizeRobinhoodSignalConfig(input = {}) {
  const requestedProtocols = normalizeProtocols(input.protocols);
  const config = {
    enabled: input.enabled === true,
    mode: 'dry-run',
    protocols: AGGREGATE_PROTOCOLS,
    requestedProtocols,
    windowMs: optionalWindowMs(input.windowMs),
    minLiquidityUsd: optionalDecimal(input.minLiquidityUsd, 'minLiquidityUsd'),
    minVolumeUsd: optionalDecimal(input.minVolumeUsd, 'minVolumeUsd'),
    minTransactions: optionalSafeInteger(input.minTransactions, 'minTransactions', true),
    maxAgeMs: optionalMaxAgeMs(input.maxAgeMs),
  };
  const missingFields = CONFIG_FIELDS.filter((field) => config[field] == null);
  return Object.freeze({ ...config, configured: missingFields.length === 0, missingFields });
}

function decimalAtLeast(actualValue, thresholdValue) {
  const actual = parseDecimal(actualValue, 'gate actual');
  const threshold = parseDecimal(thresholdValue, 'gate threshold');
  return actual.numerator * threshold.denominator >= threshold.numerator * actual.denominator;
}

function decimalGate(name, actual, threshold) {
  if (actual == null || String(actual).trim() === '') {
    return { name, passed: false, reason: `missing_${name}`, actual: null, threshold };
  }
  try {
    const parsed = parseDecimal(actual, name);
    if (parsed.numerator < 0n) throw new Error('negative');
    const passed = decimalAtLeast(actual, threshold);
    return { name, passed, reason: passed ? null : `below_${name}`, actual: String(actual), threshold };
  } catch (_) {
    return { name, passed: false, reason: `invalid_${name}`, actual: String(actual), threshold };
  }
}

function transactionsGate(actual, threshold) {
  const parsed = Number(actual);
  const valid = Number.isSafeInteger(parsed) && parsed >= 0;
  const passed = valid && parsed >= threshold;
  return {
    name: 'transactions',
    passed,
    reason: passed ? null : (valid ? 'below_transactions' : 'invalid_transactions'),
    actual: valid ? parsed : null,
    threshold,
  };
}

function ageGate(discoveredAt, maxAgeMs, nowMs) {
  const timestampMs = discoveredAt instanceof Date
    ? discoveredAt.getTime()
    : Date.parse(String(discoveredAt || ''));
  const ageMs = nowMs - timestampMs;
  const valid = Number.isFinite(timestampMs) && ageMs >= 0;
  const passed = valid && ageMs <= maxAgeMs;
  return {
    name: 'age',
    passed,
    reason: passed ? null : (valid ? 'above_age' : 'invalid_age'),
    actual: valid ? ageMs : null,
    threshold: maxAgeMs,
  };
}

function candidateBase(candidate = {}) {
  const chain = String(candidate.chain || CHAIN).trim().toLowerCase();
  const protocol = String(candidate.protocol || '').trim().toLowerCase();
  if (chain !== CHAIN) return { error: 'wrong_chain', chain, protocol, tokenAddress: null };
  if (!PROTOCOLS.has(protocol)) return { error: 'unsupported_protocol', chain, protocol, tokenAddress: null };
  const marketKey = String(candidate.marketKey || '').trim().toLowerCase();
  if (!marketKey.startsWith(`${CHAIN}:${protocol}:`)) {
    return { error: 'invalid_market_key', chain, protocol, marketKey, tokenAddress: null };
  }
  try {
    return {
      error: null,
      chain,
      protocol,
      marketKey,
      tokenAddress: normalizeTokenAddress(CHAIN, candidate.tokenAddress),
    };
  } catch (_) {
    return { error: 'invalid_token_address', chain, protocol, marketKey, tokenAddress: null };
  }
}

function suppressedResult(base, config, reason, extra = {}) {
  return {
    ...base,
    mode: 'dry-run',
    publishable: false,
    expectedSignal: false,
    decision: 'suppressed',
    reasons: [reason],
    config,
    gates: [],
    ...extra,
  };
}

function createRobinhoodSignalDryRunEvaluator(options = {}) {
  const config = normalizeRobinhoodSignalConfig(options.config);
  const blocklist = options.adminBlocklist || null;
  const now = options.now || Date.now;

  async function evaluate(candidate = {}) {
    const base = candidateBase(candidate);
    if (base.error) return suppressedResult(base, config, base.error);
    if (!config.enabled) return suppressedResult(base, config, 'dry_run_disabled');
    if (!config.configured) return suppressedResult(base, config, 'gates_not_configured');
    if (candidate.windowMs !== config.windowMs) {
      return suppressedResult(base, config, 'window_mismatch');
    }

    const eligibility = classifyTokenEligibility(base.tokenAddress, options.policyOptions);
    if (!eligibility.eligible) {
      return suppressedResult(base, config, eligibility.reason, { eligibility, adminBlocked: false });
    }
    let quoteAddress;
    try {
      quoteAddress = normalizeTokenAddress(CHAIN, candidate.quoteAddress);
    } catch (_) {
      return suppressedResult(base, config, 'invalid_quote_address', {
        eligibility,
        adminBlocked: false,
      });
    }
    if (quoteAddress !== ROBINHOOD_WETH && quoteAddress !== ROBINHOOD_USDG) {
      return suppressedResult(base, config, 'unsupported_quote', { eligibility, adminBlocked: false });
    }
    if (typeof blocklist?.hasAddress !== 'function') {
      return suppressedResult(base, config, 'admin_blocklist_unavailable', {
        eligibility,
        adminBlocked: null,
      });
    }
    const adminBlocked = await blocklist.hasAddress(base.tokenAddress, CHAIN);
    if (adminBlocked) {
      return suppressedResult(base, config, 'admin_blocked', { eligibility, adminBlocked });
    }

    const gates = [
      decimalGate('volume_usd', candidate.volumeUsd, config.minVolumeUsd),
      transactionsGate(candidate.transactions, config.minTransactions),
      ageGate(candidate.discoveredAt, config.maxAgeMs, now()),
    ];
    const reasons = gates.filter((gate) => !gate.passed).map((gate) => gate.reason);
    const expectedSignal = reasons.length === 0;
    return {
      ...base,
      mode: 'dry-run',
      publishable: false,
      expectedSignal,
      decision: expectedSignal ? 'expected-signal' : 'suppressed',
      reasons,
      config,
      gates,
      liquidity: Object.freeze({
        coverage: candidate.liquidityCoverage || 'unknown',
        valueUsd: candidate.liquidityUsd == null ? null : String(candidate.liquidityUsd),
        primaryMarketValueUsd: candidate.primaryMarketLiquidityUsd == null
          ? null
          : String(candidate.primaryMarketLiquidityUsd),
        status: candidate.liquidityStatus || 'unknown',
        threshold: config.minLiquidityUsd,
        gateApplied: false,
        reason: 'multiprotocol_liquidity_gate_disabled',
      }),
      eligibility,
      adminBlocked,
      windowMs: config.windowMs,
    };
  }

  return Object.freeze({ evaluate, getConfig: () => config });
}

module.exports = {
  AGGREGATE_PROTOCOLS,
  HVNC_MAX_AGE_MS,
  createRobinhoodSignalDryRunEvaluator,
  normalizeRobinhoodSignalConfig,
};
