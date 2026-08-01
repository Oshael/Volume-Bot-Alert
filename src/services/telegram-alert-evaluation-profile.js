const {
  RULE_CONTRACTS,
  validateRuleSettings,
} = require('./telegram-alert-rule-contracts');

const MINUTE_MS = 60 * 1000;
const RULE_ENABLED_FIELDS = Object.freeze({
  'monitored-vol': 'monitoredVol',
  'monitored-mcap': 'monitoredMcap',
  'monitored-fdv': 'monitoredFdv',
  hvnc: 'hvnc',
  'robinhood-hvnc-v2': 'hvnc',
  'recent-surge-1h': 'recentSurge1h',
  'recent-surge-6h': 'recentSurge6h',
  'old-week-surge-1h': 'oldWeekSurge1h',
  'old-week-surge-6h': 'oldWeekSurge6h',
  'meteora-surge': 'meteoraSurge',
});

function positiveId(value, field) {
  let normalized;
  try {
    normalized = BigInt(String(value ?? '').trim());
  } catch (_) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  if (normalized <= 0n) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return normalized.toString();
}

function positiveVersion(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return normalized;
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be boolean`);
  }
  return value;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function optionalTimestamp(value, field) {
  return value == null ? null : timestamp(value, field);
}

function adaptReactivation(value) {
  if (value == null) {
    return Object.freeze({ pending: false, requestedAt: null, reactivatedAt: null });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Telegram alert reactivation context must be an object');
  }
  const status = String(value.status || '').trim();
  const requestedAt = optionalTimestamp(value.requested_at, 'reactivation requested_at');
  const reactivatedAt = optionalTimestamp(value.reactivated_at, 'reactivated_at');
  const pending = status === 'access_suspended';
  if (!['active', 'access_suspended'].includes(status)
    || (pending && !requestedAt)
    || (!pending && requestedAt)) {
    throw new TypeError('Telegram alert reactivation context is inconsistent');
  }
  return Object.freeze({ pending, requestedAt, reactivatedAt });
}

function adaptRule(profile, row, ruleKey) {
  if (!row) {
    throw new TypeError(`Missing Telegram alert rule: ${profile.chain}/${ruleKey}`);
  }
  if (positiveId(row.profile_id, 'rule profile_id') !== profile.profileId) {
    throw new TypeError(`Telegram alert rule profile mismatch: ${ruleKey}`);
  }
  if (row.chain !== profile.chain || row.rule_key !== ruleKey) {
    throw new TypeError(`Telegram alert rule identity mismatch: ${ruleKey}`);
  }

  const settings = validateRuleSettings(profile.chain, ruleKey, row.settings_json);
  return Object.freeze({
    ruleKey,
    enabled: requiredBoolean(row.enabled, `rule ${ruleKey} enabled`),
    version: positiveVersion(row.version, `rule ${ruleKey} version`),
    updatedAt: timestamp(row.updated_at, `rule ${ruleKey} updated_at`),
    cooldownMs: settings.cooldownMinutes * MINUTE_MS,
    settings: Object.freeze(settings),
  });
}

function indexRules(rows, expectedRuleKeys) {
  if (!Array.isArray(rows)) {
    throw new TypeError('Telegram alert rules must be an array');
  }
  const expected = new Set(expectedRuleKeys);
  const indexed = new Map();
  for (const row of rows) {
    const ruleKey = String(row?.rule_key || '').trim();
    if (!expected.has(ruleKey)) {
      throw new TypeError(`Unexpected Telegram alert rule: ${ruleKey || 'missing'}`);
    }
    if (indexed.has(ruleKey)) {
      throw new TypeError(`Duplicate Telegram alert rule: ${ruleKey}`);
    }
    indexed.set(ruleKey, row);
  }
  return indexed;
}

function buildRuleEnabled(rules) {
  const enabled = {};
  for (const rule of rules) {
    const field = RULE_ENABLED_FIELDS[rule.ruleKey];
    if (field) enabled[field] = Boolean(rule.enabled);
  }
  return Object.freeze(enabled);
}

function adaptTelegramAlertEvaluationProfile(input = {}) {
  const row = input.profile;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Telegram alert profile row is required');
  }
  const chain = String(row.chain || '').trim();
  const contracts = RULE_CONTRACTS[chain];
  if (!contracts) {
    throw new TypeError(`Unsupported Telegram alert chain: ${chain || 'missing'}`);
  }

  const profile = {
    profileId: positiveId(row.id, 'profile id'),
    connectionId: positiveId(row.connection_id, 'connection id'),
    userId: Number(positiveId(row.user_id, 'user id')),
    chain,
  };
  if (!Number.isSafeInteger(profile.userId)) {
    throw new TypeError('user id exceeds the supported integer range');
  }

  const ruleKeys = Object.keys(contracts);
  const indexed = indexRules(input.rules, ruleKeys);
  const rules = ruleKeys.map((ruleKey) => adaptRule(profile, indexed.get(ruleKey), ruleKey));
  const reactivation = adaptReactivation(input.reactivation);

  return Object.freeze({
    destination: 'telegram',
    ...profile,
    enabled: requiredBoolean(row.enabled, 'profile enabled'),
    sparklineEnabled: requiredBoolean(row.sparkline_enabled, 'profile sparkline_enabled'),
    version: positiveVersion(row.version, 'profile version'),
    updatedAt: timestamp(row.updated_at, 'profile updated_at'),
    reactivation,
    ruleEnabled: buildRuleEnabled(rules),
    rules: Object.freeze(rules),
  });
}

module.exports = {
  adaptTelegramAlertEvaluationProfile,
};
