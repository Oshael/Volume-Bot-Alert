const { normalizeTokenAddress } = require('../utils/token-identity');
const { parseDecimal } = require('./evm-market-metrics');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_HVNC_MIN_VOLUME_USD = 300_000;
// Preserved to avoid resetting existing user cursors and dedupe history.
const RULE_KEY = 'robinhood-hvnc-v2';
const KIND = 'hvnc';

function inactive(status, reason) {
  return Object.freeze({
    status,
    reason,
    evaluatedProfiles: 0,
    matchedProfiles: 0,
    intents: Object.freeze([]),
  });
}

function toNumberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestampMs(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be valid`);
  return parsed.getTime();
}

function normalizeUserId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validatePublicationInput(candidate, decision) {
  if (candidate?.chain !== CHAIN || decision?.chain !== CHAIN) {
    throw new Error('Robinhood alert matching requires Robinhood identities');
  }
  if (!PROTOCOLS.has(candidate.protocol) || decision.protocol !== candidate.protocol) {
    throw new Error('Robinhood alert primary protocol is invalid or mismatched');
  }
  if (Number(candidate.windowMs) !== WINDOW_MS) {
    throw new Error('Robinhood alert matching requires a 5 minute window');
  }

  const tokenAddress = normalizeTokenAddress(CHAIN, candidate.tokenAddress);
  if (normalizeTokenAddress(CHAIN, decision.tokenAddress) !== tokenAddress) {
    throw new Error('Robinhood alert decision token does not match candidate');
  }
  if (decision.marketKey !== candidate.marketKey) {
    throw new Error('Robinhood alert decision market does not match candidate');
  }
  return tokenAddress;
}

function profileHvncMinVolumeUsd(profile) {
  const value = toNumberOrNull(profile?.hvncMinVol);
  return value != null && value >= 0 ? value : DEFAULT_HVNC_MIN_VOLUME_USD;
}

function meetsProfileHvncMinimum(profile, volumeUsd) {
  try {
    const volume = parseDecimal(volumeUsd, 'candidate volumeUsd');
    const minimum = parseDecimal(profileHvncMinVolumeUsd(profile), 'profile hvncMinVol');
    return volume.numerator >= 0n
      && volume.numerator * minimum.denominator
        >= minimum.numerator * volume.denominator;
  } catch (_) {
    return false;
  }
}

function isProfileEligible(profile, candidate) {
  return normalizeUserId(profile?.userId) != null
    && profile?.ruleEnabled?.hvnc === true
    && meetsProfileHvncMinimum(profile, candidate?.volumeUsd);
}

function buildDedupeKey(userId, tokenAddress) {
  return `${userId}:${RULE_KEY}:${CHAIN}:${tokenAddress}`;
}

function buildPayload(candidate, tokenAddress) {
  const fdv = toNumberOrNull(candidate.lastFdvUsd);
  const marketIdentity = candidate.marketKey.slice(
    `${CHAIN}:${candidate.protocol}:`.length
  );
  return Object.freeze({
    source: 'robinhood-onchain',
    aggregation: 'token-multiprotocol',
    protocol: candidate.protocol,
    protocols: Object.keys(candidate.protocolBreakdown || {}).sort(),
    marketKey: candidate.marketKey,
    address: tokenAddress,
    pairAddress: candidate.protocol === 'uniswap-v4' ? null : marketIdentity,
    poolId: candidate.protocol === 'uniswap-v4' ? marketIdentity : null,
    quoteAddress: normalizeTokenAddress(CHAIN, candidate.quoteAddress),
    tokenCreatedAt: toTimestampMs(candidate.discoveredAt, 'candidate discoveredAt'),
    triggeredWindowStart: new Date(toTimestampMs(candidate.windowStart, 'candidate windowStart')).toISOString(),
    triggeredWindowEnd: new Date(toTimestampMs(candidate.windowEnd, 'candidate windowEnd')).toISOString(),
    label: 'HVNC',
    pct: 0,
    isHvnc: true,
    volume5m: toNumberOrNull(candidate.volumeUsd),
    volume24h: null,
    liquidityUsd: toNumberOrNull(candidate.liquidityUsd),
    liquidityCoverage: candidate.liquidityCoverage || 'unknown',
    liquidityStatus: candidate.liquidityStatus || 'unknown',
    transactions: toNumberOrNull(candidate.transactions),
    priceUsd: toNumberOrNull(candidate.lastPriceUsd),
    mcap: null,
    fdv,
    valuationType: fdv == null ? null : 'fdv',
    protocolBreakdown: candidate.protocolBreakdown || {},
    marketBreakdown: candidate.marketBreakdown || [],
  });
}

function createIntent(profile, candidate, tokenAddress) {
  const userId = normalizeUserId(profile.userId);
  return Object.freeze({
    userId,
    chain: CHAIN,
    ruleKey: RULE_KEY,
    kind: KIND,
    tokenAddress,
    dedupeKey: buildDedupeKey(userId, tokenAddress),
    triggeredAt: new Date(toTimestampMs(candidate.windowEnd, 'candidate windowEnd')),
    payload: buildPayload(candidate, tokenAddress),
  });
}

function createRobinhoodAlertMatcher() {
  function match(input = {}) {
    if (input.alertsRequested !== true) return inactive('disabled', 'alerts_disabled');
    if (input.publishable !== true) return inactive('blocked', 'rollout_not_publishable');
    if (input.decision?.publishable !== true) return inactive('blocked', 'decision_not_publishable');
    if (input.decision?.expectedSignal !== true) return inactive('suppressed', 'signal_suppressed');

    const tokenAddress = validatePublicationInput(input.candidate, input.decision);
    const profiles = Array.isArray(input.profiles) ? input.profiles : [];
    const eligibleProfiles = profiles.filter(
      (profile) => isProfileEligible(profile, input.candidate)
    );
    const intents = eligibleProfiles.map((profile) => createIntent(profile, input.candidate, tokenAddress));
    return Object.freeze({
      status: 'completed',
      reason: null,
      evaluatedProfiles: profiles.length,
      matchedProfiles: eligibleProfiles.length,
      intents: Object.freeze(intents),
    });
  }

  return Object.freeze({ match });
}

module.exports = {
  CHAIN,
  DEFAULT_HVNC_MIN_VOLUME_USD,
  KIND,
  PROTOCOLS,
  RULE_KEY,
  WINDOW_MS,
  createRobinhoodAlertMatcher,
  __private: {
    buildDedupeKey,
    buildPayload,
    isProfileEligible,
    meetsProfileHvncMinimum,
    profileHvncMinVolumeUsd,
    validatePublicationInput,
  },
};
