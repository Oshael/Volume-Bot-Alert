const db = require('./db');

// ── Whitelist de config keys com tipo e validação ──────────────────
// Qualquer key fora dessa lista é rejeitada (previne injeção de configs arbitrárias)
const CONFIG_SCHEMA = {
  threshold:        { type: 'number', min: 0, max: 10000, default: 50 },
  'mcap-threshold': { type: 'number', min: 0, max: 10000, default: 50 },
  'fdv-threshold':  { type: 'number', min: 0, max: 10000, default: 50 },
  'min-vol':        { type: 'number', min: 0, max: 1e12, default: 10000 },
  'min-mcap':       { type: 'number', min: 30000, max: 1e12, default: 30000 },
  'max-mcap':       { type: 'number', min: 0, max: 1e15, default: 0 },
  'min-mcap-remove':{ type: 'number', min: 0, max: 1e12, default: 0 },
  interval:         { type: 'number', min: 5, max: 600, default: 30 },
  'dead-cycles':    { type: 'number', min: 1, max: 1000, default: 10 },
  chain:            { type: 'string', allowed: ['solana', 'ethereum', 'bsc', 'base'], default: 'solana' },
  'old-mcap-min':    { type: 'number', min: 0, max: 1e15, default: 120000 },
  'old-mcap-max':    { type: 'number', min: 0, max: 1e15, default: 100000000 },
  'old-fdv-min':     { type: 'number', min: 0, max: 1e15, default: 120000 },
  'old-fdv-max':     { type: 'number', min: 0, max: 1e15, default: 100000000 },
  'recent-age-min':  { type: 'number', min: 0, max: 10080, default: 0 },
  'recent-age-max':  { type: 'number', min: 0, max: 10080, default: 10080 },
  'old-per-page':    { type: 'number', min: 10, max: 500, default: 15 },
  'old-week-mcap-min': { type: 'number', min: 0, max: 1e15, default: 120000 },
  'old-week-mcap-max': { type: 'number', min: 0, max: 1e15, default: 100000000 },
  'old-week-fdv-min': { type: 'number', min: 0, max: 1e15, default: 120000 },
  'old-week-fdv-max': { type: 'number', min: 0, max: 1e15, default: 100000000 },
  'old-week-age-min': { type: 'number', min: 10080, max: 52560000, default: 10080 },
  'old-week-age-max': { type: 'number', min: 0, max: 52560000, default: 0 },
  'old-week-per-page': { type: 'number', min: 10, max: 500, default: 15 },
  'monitored-mcap-min': { type: 'number', min: 0, max: 1e15, default: 30000 },
  'monitored-fdv-min': { type: 'number', min: 0, max: 1e15, default: 30000 },
  'monitored-view-mcap-max': { type: 'number', min: 0, max: 1e15, default: 0 },
  'monitored-view-fdv-max': { type: 'number', min: 0, max: 1e15, default: 0 },
  'monitored-fdv-max': { type: 'number', min: 0, max: 1e15, default: 0 },
  'hvnc-min-vol':    { type: 'number', min: 0, max: 1e15, default: 300000 },
  'old-alert-1h-threshold': { type: 'number', min: 0, max: 10000, default: 50 },
  'old-alert-6h-threshold': { type: 'number', min: 0, max: 10000, default: 100 },
  'recent-surge-1h-threshold': { type: 'number', min: 0, max: 10000, default: 50 },
  'recent-surge-6h-threshold': { type: 'number', min: 0, max: 10000, default: 100 },
  'old-week-surge-1h-threshold': { type: 'number', min: 0, max: 10000, default: 50 },
  'old-week-surge-6h-threshold': { type: 'number', min: 0, max: 10000, default: 100 },
  'meteora-alert-1h-threshold': { type: 'number', min: 0, max: 10000, default: 50 },
  'alert-vol-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-mcap-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-fdv-enabled': { type: 'string', allowed: ['on', 'off'], default: 'off' },
  'alert-hvnc-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-old-surge-1h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-old-surge-6h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-recent-surge-1h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-recent-surge-6h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-old-week-surge-1h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-old-week-surge-6h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-meteora-surge-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-gmgn-claim-signal-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-gmgn-claim-pump-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'alert-gmgn-claim-bags-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'block-warning-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-vol-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-mcap-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-hvnc-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-old-surge-1h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-old-surge-6h-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-meteora-surge-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'sound-gmgn-claim-signal-enabled': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'meteora-min-pool': { type: 'number', min: 0, max: 1e15, default: 5000 },
  'sound-volume':    { type: 'number', min: 0, max: 100, default: 50 },
  'sound-mode':      { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'card-effects-mode': { type: 'string', allowed: ['on', 'off'], default: 'on' },
  'mock-sol-usdc-rate': { type: 'number', min: 0.01, max: 1000000, default: 88 },
};

function validateConfigEntry(key, value) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) {
    return { valid: false, error: `Unknown config key: ${key}` };
  }

  if (schema.type === 'number') {
    if (value === null || value === undefined) {
      return { valid: false, error: `${key} must be a finite number` };
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return { valid: false, error: `${key} must be a finite number` };
    }
    if (num < schema.min || num > schema.max) {
      return { valid: false, error: `${key} must be between ${schema.min} and ${schema.max}` };
    }
    return { valid: true, value: num };
  }

  if (schema.type === 'string') {
    const str = String(value).trim();
    if (schema.allowed && !schema.allowed.includes(str)) {
      return { valid: false, error: `${key} must be one of: ${schema.allowed.join(', ')}` };
    }
    if (str.length > 64) {
      return { valid: false, error: `${key} must be 64 chars or less` };
    }
    return { valid: true, value: str };
  }

  return { valid: false, error: `Unknown type for ${key}` };
}

function validateConfigs(obj) {
  const configs = {};
  const errors = [];

  for (const [key, value] of Object.entries(obj)) {
    const result = validateConfigEntry(key, value);
    if (result.valid) {
      configs[key] = result.value;
    } else {
      errors.push(result.error);
    }
  }

  return {
    valid: errors.length === 0,
    configs,
    errors,
  };
}

function buildDefaultConfigs() {
  const configs = {};
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    configs[key] = schema.default;
  }
  return configs;
}

function applyLegacySurgeConfigFallbacks(configs, storedKeys = new Set()) {
  const safeStoredKeys = storedKeys instanceof Set ? storedKeys : new Set();
  const thresholdFallbacks = [
    ['recent-surge-1h-threshold', 'old-alert-1h-threshold'],
    ['recent-surge-6h-threshold', 'old-alert-6h-threshold'],
    ['old-week-surge-1h-threshold', 'old-alert-1h-threshold'],
    ['old-week-surge-6h-threshold', 'old-alert-6h-threshold'],
  ];
  const enabledFallbacks = [
    ['alert-recent-surge-1h-enabled', 'alert-old-surge-1h-enabled'],
    ['alert-recent-surge-6h-enabled', 'alert-old-surge-6h-enabled'],
    ['alert-old-week-surge-1h-enabled', 'alert-old-surge-1h-enabled'],
    ['alert-old-week-surge-6h-enabled', 'alert-old-surge-6h-enabled'],
  ];

  for (const [primaryKey, legacyKey] of thresholdFallbacks) {
    if (!safeStoredKeys.has(primaryKey) && safeStoredKeys.has(legacyKey)) {
      configs[primaryKey] = configs[legacyKey];
    }
  }

  for (const [primaryKey, legacyKey] of enabledFallbacks) {
    if (!safeStoredKeys.has(primaryKey) && safeStoredKeys.has(legacyKey)) {
      configs[primaryKey] = configs[legacyKey];
    }
  }

  return configs;
}

function applyLegacyGmgnClaimConfigFallbacks(configs, storedKeys = new Set()) {
  const safeStoredKeys = storedKeys instanceof Set ? storedKeys : new Set();
  const legacyKey = 'alert-gmgn-claim-signal-enabled';
  if (!safeStoredKeys.has(legacyKey)) {
    return configs;
  }

  for (const key of ['alert-gmgn-claim-pump-enabled', 'alert-gmgn-claim-bags-enabled']) {
    if (!safeStoredKeys.has(key)) {
      configs[key] = configs[legacyKey];
    }
  }
  return configs;
}

async function getAllWithStoredKeys(userId) {
  const { rows } = await db.query(
    'SELECT config_key, config_value, updated_at FROM user_configs WHERE user_id = $1',
    [userId]
  );

  const configs = buildDefaultConfigs();
  const storedKeys = new Set();
  let configVersion = null;

  for (const row of rows) {
    const schema = CONFIG_SCHEMA[row.config_key];
    if (schema) {
      storedKeys.add(row.config_key);
      configs[row.config_key] = schema.type === 'number'
        ? Number(row.config_value)
        : row.config_value;
    }

    const updatedAtMs = row.updated_at instanceof Date
      ? row.updated_at.getTime()
      : new Date(row.updated_at || 0).getTime();
    if (Number.isFinite(updatedAtMs) && (!configVersion || updatedAtMs > configVersion.getTime())) {
      configVersion = new Date(updatedAtMs);
    }
  }

  applyLegacySurgeConfigFallbacks(configs, storedKeys);
  applyLegacyGmgnClaimConfigFallbacks(configs, storedKeys);
  return {
    configs,
    storedKeys,
    configVersion: configVersion ? configVersion.toISOString() : null,
  };
}

async function getAll(userId) {
  const result = await getAllWithStoredKeys(userId);
  return result.configs;
}

async function setMultiple(userId, configs) {
  if (Object.keys(configs).length === 0) return;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(configs)) {
      await client.query(
        `INSERT INTO user_configs (user_id, config_key, config_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, config_key)
         DO UPDATE SET config_value = $3, updated_at = NOW()`,
        [userId, key, String(value)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function replaceAll(userId, configs) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_configs WHERE user_id = $1', [userId]);
    for (const [key, value] of Object.entries(configs)) {
      await client.query(
        'INSERT INTO user_configs (user_id, config_key, config_value) VALUES ($1, $2, $3)',
        [userId, key, String(value)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function remove(userId, key) {
  const { rowCount } = await db.query(
    'DELETE FROM user_configs WHERE user_id = $1 AND config_key = $2',
    [userId, key]
  );
  return rowCount > 0;
}

async function getVersion(userId) {
  const { rows } = await db.query(
    'SELECT MAX(updated_at) AS config_version FROM user_configs WHERE user_id = $1',
    [userId]
  );
  const value = rows[0]?.config_version || null;
  const parsed = value instanceof Date ? value : new Date(value || 0);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function getVersions(userIds) {
  const normalizedUserIds = [...new Set((userIds || [])
    .map((userId) => Number.parseInt(String(userId || '').trim(), 10))
    .filter((userId) => Number.isInteger(userId) && userId > 0))];
  const versions = new Map(normalizedUserIds.map((userId) => [userId, null]));
  if (normalizedUserIds.length === 0) return versions;

  const { rows } = await db.query(
    `SELECT user_id, MAX(updated_at) AS config_version
     FROM user_configs
     WHERE user_id = ANY($1::bigint[])
     GROUP BY user_id`,
    [normalizedUserIds]
  );
  for (const row of rows) {
    const userId = Number(row.user_id);
    const parsed = row.config_version instanceof Date
      ? row.config_version
      : new Date(row.config_version || 0);
    versions.set(userId, Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null);
  }
  return versions;
}

module.exports = {
  CONFIG_SCHEMA,
  applyLegacyGmgnClaimConfigFallbacks,
  applyLegacySurgeConfigFallbacks,
  buildDefaultConfigs,
  getAllWithStoredKeys,
  getVersion,
  getVersions,
  validateConfigEntry,
  validateConfigs,
  getAll,
  setMultiple,
  replaceAll,
  remove,
};
