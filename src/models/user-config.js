const db = require('./db');

// ── Whitelist de config keys com tipo e validação ──────────────────
// Qualquer key fora dessa lista é rejeitada (previne injeção de configs arbitrárias)
const CONFIG_SCHEMA = {
  threshold:        { type: 'number', min: 0, max: 10000, default: 50 },
  'mcap-threshold': { type: 'number', min: 0, max: 10000, default: 50 },
  'min-vol':        { type: 'number', min: 0, max: 1e12, default: 500 },
  'min-mcap':       { type: 'number', min: 0, max: 1e12, default: 10000 },
  'max-mcap':       { type: 'number', min: 0, max: 1e15, default: 0 },
  'min-mcap-remove':{ type: 'number', min: 0, max: 1e12, default: 0 },
  interval:         { type: 'number', min: 5, max: 600, default: 30 },
  'dead-cycles':    { type: 'number', min: 1, max: 1000, default: 10 },
  chain:            { type: 'string', allowed: ['solana', 'ethereum', 'bsc', 'base'], default: 'solana' },
  'pump-entry-vol': { type: 'number', min: 0, max: 1e12, default: 20000 },
  'pump-min-vol':   { type: 'number', min: 0, max: 1e12, default: 100000 },
  'pump-bond-mcap': { type: 'number', min: 0, max: 1e12, default: 35000 },
  'old-mcap-min':   { type: 'number', min: 0, max: 1e15, default: 120000 },
  'old-mcap-max':   { type: 'number', min: 0, max: 1e15, default: 1000000 },
  'hvnc-min-vol':   { type: 'number', min: 0, max: 1e15, default: 300000 },
  'sound-volume':   { type: 'number', min: 0, max: 100, default: 50 },
};

/**
 * Valida uma key+value contra o schema.
 * Retorna { valid, value (sanitizado), error }
 */
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

/**
 * Valida um objeto inteiro de configs.
 * Retorna { valid, configs (sanitizados), errors[] }
 */
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

/**
 * GET all configs for a user. Returns object with defaults filled in.
 */
async function getAll(userId) {
  const { rows } = await db.query(
    'SELECT config_key, config_value FROM user_configs WHERE user_id = $1',
    [userId]
  );

  // Start with defaults
  const configs = {};
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    configs[key] = schema.default;
  }

  // Override with saved values
  for (const row of rows) {
    const schema = CONFIG_SCHEMA[row.config_key];
    if (schema) {
      configs[row.config_key] = schema.type === 'number'
        ? Number(row.config_value)
        : row.config_value;
    }
  }

  return configs;
}

/**
 * SET (upsert) multiple configs at once. Only valid keys are written.
 */
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

/**
 * REPLACE all configs (PUT semantics): delete all, then insert new ones.
 * Keys not included revert to defaults.
 */
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

/**
 * DELETE a single config key (revert to default).
 */
async function remove(userId, key) {
  const { rowCount } = await db.query(
    'DELETE FROM user_configs WHERE user_id = $1 AND config_key = $2',
    [userId, key]
  );
  return rowCount > 0;
}

module.exports = {
  CONFIG_SCHEMA,
  validateConfigEntry,
  validateConfigs,
  getAll,
  setMultiple,
  replaceAll,
  remove,
};
