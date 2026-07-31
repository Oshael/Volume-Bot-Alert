const DEFAULTS_VERSION = 1;
const MAX_COOLDOWN_MINUTES = 7 * 24 * 60;

const FIELD_SPECS = Object.freeze({
  defaultsVersion: { min: 1, max: DEFAULTS_VERSION, integer: true },
  thresholdPct: { min: 0, max: 10_000 },
  cooldownMinutes: { min: 0, max: MAX_COOLDOWN_MINUTES, integer: true },
  minVolumeUsd: { min: 0, max: 1e12 },
  minHvncVolumeUsd: { min: 0, max: 1e15 },
  minMarketCapUsd: { min: 30_000, max: 1e12 },
  maxMarketCapUsd: { min: 0, max: 1e15 },
  minFdvUsd: { min: 0, max: 1e15 },
  maxFdvUsd: { min: 0, max: 1e15 },
});

function contract(enabled, defaults) {
  const versionedDefaults = { defaultsVersion: DEFAULTS_VERSION, ...defaults };
  return Object.freeze({
    enabled,
    fields: Object.freeze(Object.keys(versionedDefaults)),
    defaults: Object.freeze(versionedDefaults),
  });
}

function surge(thresholdPct, cooldownMinutes) {
  return contract(true, { thresholdPct, cooldownMinutes });
}

const SHARED = Object.freeze({
  'monitored-vol': contract(true, {
    thresholdPct: 50,
    cooldownMinutes: 1,
    minVolumeUsd: 10_000,
  }),
  hvnc: contract(true, {
    minHvncVolumeUsd: 300_000,
    cooldownMinutes: 0,
  }),
  'recent-surge-1h': surge(50, 0),
  'recent-surge-6h': surge(100, 360),
  'old-week-surge-1h': surge(50, 0),
  'old-week-surge-6h': surge(100, 360),
});

const RULE_CONTRACTS = Object.freeze({
  solana: Object.freeze({
    ...SHARED,
    'monitored-mcap': contract(true, {
      thresholdPct: 50,
      cooldownMinutes: 1,
      minVolumeUsd: 10_000,
      minMarketCapUsd: 30_000,
      maxMarketCapUsd: 0,
    }),
    'meteora-surge': surge(50, 30),
  }),
  robinhood: Object.freeze({
    'monitored-vol': SHARED['monitored-vol'],
    'monitored-fdv': contract(false, {
      thresholdPct: 50,
      cooldownMinutes: 1,
      minVolumeUsd: 10_000,
      minFdvUsd: 30_000,
      maxFdvUsd: 0,
    }),
    'robinhood-hvnc-v2': contract(true, {
      minHvncVolumeUsd: 300_000,
      cooldownMinutes: 0,
    }),
    'recent-surge-1h': SHARED['recent-surge-1h'],
    'recent-surge-6h': SHARED['recent-surge-6h'],
    'old-week-surge-1h': SHARED['old-week-surge-1h'],
    'old-week-surge-6h': SHARED['old-week-surge-6h'],
  }),
});

function ruleContract(chain, ruleKey) {
  const resolved = RULE_CONTRACTS[chain]?.[ruleKey];
  if (!resolved) {
    throw new TypeError(`Unsupported Telegram alert rule: ${chain}/${ruleKey}`);
  }
  return resolved;
}

function settingFieldSpec(chain, ruleKey, field) {
  const spec = ruleContract(chain, ruleKey);
  if (field === 'defaultsVersion' || !spec.fields.includes(field)) {
    throw new TypeError(`Unsupported Telegram alert setting field: ${field}`);
  }
  return FIELD_SPECS[field];
}

function validateRange(settings, minKey, maxKey) {
  const max = settings[maxKey];
  if (max !== undefined && max !== 0 && max < settings[minKey]) {
    throw new TypeError(`${maxKey} must be zero or greater than or equal to ${minKey}`);
  }
}

function validateRuleSettings(chain, ruleKey, settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('Telegram rule settings must be an object');
  }
  const spec = ruleContract(chain, ruleKey);
  const keys = Object.keys(settings);
  const unknown = keys.filter((key) => !spec.fields.includes(key));
  const missing = spec.fields.filter((key) => !Object.hasOwn(settings, key));
  if (unknown.length || missing.length) {
    throw new TypeError(
      `Invalid settings fields for ${chain}/${ruleKey}: `
      + `unknown=${unknown.join(',') || 'none'} missing=${missing.join(',') || 'none'}`
    );
  }

  const normalized = {};
  for (const field of spec.fields) {
    const value = Number(settings[field]);
    const fieldSpec = FIELD_SPECS[field];
    if (!Number.isFinite(value)
      || value < fieldSpec.min
      || value > fieldSpec.max
      || (fieldSpec.integer && !Number.isInteger(value))) {
      throw new TypeError(
        `${field} must be ${fieldSpec.integer ? 'an integer ' : ''}`
        + `between ${fieldSpec.min} and ${fieldSpec.max}`
      );
    }
    normalized[field] = value;
  }
  validateRange(normalized, 'minMarketCapUsd', 'maxMarketCapUsd');
  validateRange(normalized, 'minFdvUsd', 'maxFdvUsd');
  return normalized;
}

function buildDefaultRules(chain) {
  const contracts = RULE_CONTRACTS[chain];
  if (!contracts) throw new TypeError(`Unsupported Telegram alert chain: ${chain}`);
  return Object.entries(contracts).map(([ruleKey, spec]) => ({
    chain,
    ruleKey,
    enabled: spec.enabled,
    settings: validateRuleSettings(chain, ruleKey, spec.defaults),
  }));
}

module.exports = {
  DEFAULTS_VERSION,
  MAX_COOLDOWN_MINUTES,
  RULE_CONTRACTS,
  buildDefaultRules,
  settingFieldSpec,
  validateRuleSettings,
};
