const db = require('./db');
const { isValidAddress } = require('./user-token');

const VALID_METRICS = new Set(['price', 'mcap']);
const VALID_OPERATORS = new Set(['cross_above', 'cross_below']);
const VALID_STATUSES = new Set(['active', 'triggered', 'disabled']);
const MAX_SOUND_DATA_URL_LENGTH = 7 * 1024 * 1024;

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw validationError('Valid user id is required');
  }
  return userId;
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  if (!isValidAddress(address)) {
    throw validationError('Invalid token address format');
  }
  return address;
}

function normalizeTitle(value) {
  const title = String(value || '').trim() || 'Custom alert';
  return title.slice(0, 64);
}

function normalizeMetric(value) {
  const metric = String(value || '').trim().toLowerCase();
  if (!VALID_METRICS.has(metric)) {
    throw validationError('Custom alert metric must be price or mcap');
  }
  return metric;
}

function normalizeOperator(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!normalized || normalized === 'hits' || normalized === 'when_it_hits') {
    return null;
  }
  if (!VALID_OPERATORS.has(normalized)) {
    throw validationError('Custom alert operator must be cross_above or cross_below');
  }
  return normalized;
}

// "When it hits" rules infer direction from where the market sat at rule creation:
// baseline above the target means we are waiting for a drop, otherwise a rise.
function deriveOperator(explicitOperator, metric, targetValue, metadata) {
  if (explicitOperator) return explicitOperator;
  const baseline = Number(metric === 'price' ? metadata?.baselinePrice : metadata?.baselineMcap);
  return Number.isFinite(baseline) && baseline > targetValue ? 'cross_below' : 'cross_above';
}

function normalizeTargetValue(value) {
  const text = String(value ?? '').trim().replace(/[$,\s]/g, '');
  const shorthand = /^(\d+(?:\.\d+)?)([kmb])$/i.exec(text);
  const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
  const target = shorthand
    ? Number(shorthand[1]) * multipliers[shorthand[2].toLowerCase()]
    : Number(text);
  if (!Number.isFinite(target) || target <= 0) {
    throw validationError('Custom alert target must be greater than 0');
  }
  return target;
}

function normalizeColorHex(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : null;
}

function normalizeSoundName(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 128) : null;
}

function normalizeSoundDataUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > MAX_SOUND_DATA_URL_LENGTH) {
    throw validationError('Custom alert sound file is too large');
  }
  if (!/^data:audio\/(?:mpeg|mp3);base64,[a-z0-9+/=]+$/i.test(text)) {
    throw validationError('Custom alert sound must be an MP3 data URL');
  }
  return text;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return null;
  if (!VALID_STATUSES.has(status)) {
    throw validationError('Invalid custom alert status');
  }
  return status;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

const MAX_EXPIRES_IN_HOURS = 24 * 365;

function normalizeExpiresInHours(value) {
  if (value == null) return null;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_EXPIRES_IN_HOURS) {
    throw validationError('Custom alert expiry must be between 1 hour and 1 year');
  }
  return hours;
}

function buildExpiresAtIso(expiresInHours, nowMs = Date.now()) {
  return new Date(nowMs + (expiresInHours * 60 * 60 * 1000)).toISOString();
}

function mapRuleRow(row) {
  if (!row) return null;
  const metadata = normalizeMetadata(row.metadata);
  return {
    id: Number(row.id) || null,
    userId: Number(row.user_id) || null,
    tokenAddress: row.token_address || null,
    title: row.title || null,
    metric: row.metric || null,
    operator: row.operator || null,
    targetValue: Number(row.target_value),
    colorHex: row.color_hex || null,
    soundName: row.sound_name || null,
    status: row.status || null,
    metadata,
    soundDataUrl: metadata.soundDataUrl || null,
    expiresAt: metadata.expiresAt || null,
    triggeredAt: row.triggered_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function createRule(userId, payload = {}, runner = db) {
  const normalizedUserId = normalizeUserId(userId);
  const tokenAddress = normalizeAddress(payload.tokenAddress);
  const title = normalizeTitle(payload.title);
  const metric = normalizeMetric(payload.metric);
  const targetValue = normalizeTargetValue(payload.targetValue ?? payload.target);
  const operator = deriveOperator(normalizeOperator(payload.operator), metric, targetValue, normalizeMetadata(payload.metadata));
  const colorHex = normalizeColorHex(payload.colorHex);
  const soundName = normalizeSoundName(payload.soundName);
  const metadata = normalizeMetadata(payload.metadata);
  const soundDataUrl = normalizeSoundDataUrl(payload.soundDataUrl ?? metadata.soundDataUrl);
  const expiresInHours = normalizeExpiresInHours(payload.expiresInHours);
  const storedMetadata = { ...metadata };
  if (soundDataUrl) storedMetadata.soundDataUrl = soundDataUrl;
  if (expiresInHours != null) storedMetadata.expiresAt = buildExpiresAtIso(expiresInHours);

  const { rows } = await runner.query(
    `INSERT INTO user_custom_alert_rules (
       user_id,
       token_address,
       title,
       metric,
       operator,
       target_value,
       color_hex,
       sound_name,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      normalizedUserId,
      tokenAddress,
      title,
      metric,
      operator,
      targetValue,
      colorHex,
      soundName,
      JSON.stringify(storedMetadata),
    ]
  );

  return mapRuleRow(rows[0] || null);
}

async function listRules(userId, filters = {}, runner = db) {
  const normalizedUserId = normalizeUserId(userId);
  const values = [normalizedUserId];
  const clauses = ['user_id = $1'];
  const status = normalizeStatus(filters.status);

  if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM user_custom_alert_rules
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, id DESC`,
    values
  );

  return rows.map(mapRuleRow);
}

async function listActiveByTokenAddress(tokenAddress, runner = db) {
  const normalizedAddress = String(tokenAddress || '').trim();
  if (!isValidAddress(normalizedAddress)) {
    return [];
  }
  const { rows } = await runner.query(
    `SELECT *
     FROM user_custom_alert_rules
     WHERE token_address = $1
       AND status = 'active'
       AND (metadata->>'expiresAt' IS NULL OR (metadata->>'expiresAt')::timestamptz > NOW())
     ORDER BY updated_at ASC, id ASC`,
    [normalizedAddress]
  );

  return rows.map(mapRuleRow);
}

async function markTriggered(id, userId, options = {}, runner = db) {
  const ruleId = Number.parseInt(String(id || '').trim(), 10);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw validationError('Valid custom alert rule id is required');
  }
  const normalizedUserId = normalizeUserId(userId);
  const triggeredAt = options.triggeredAt instanceof Date ? options.triggeredAt : new Date(options.triggeredAt || Date.now());
  if (!Number.isFinite(triggeredAt.getTime())) {
    throw validationError('Valid triggeredAt is required');
  }

  const { rows } = await runner.query(
    `UPDATE user_custom_alert_rules
     SET status = 'triggered',
         triggered_at = $3,
         updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND status = 'active'
     RETURNING *`,
    [ruleId, normalizedUserId, triggeredAt]
  );

  return mapRuleRow(rows[0] || null);
}

async function updateRule(id, userId, payload = {}, runner = db) {
  const ruleId = Number.parseInt(String(id || '').trim(), 10);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw validationError('Valid custom alert rule id is required');
  }
  const normalizedUserId = normalizeUserId(userId);
  const title = normalizeTitle(payload.title);
  const metric = normalizeMetric(payload.metric);
  const targetValue = normalizeTargetValue(payload.targetValue ?? payload.target);
  const colorHex = normalizeColorHex(payload.colorHex);
  const newSoundName = normalizeSoundName(payload.soundName);
  const soundDataUrl = normalizeSoundDataUrl(payload.soundDataUrl);

  const { rows: existingRows } = await runner.query(
    `SELECT metadata, sound_name
     FROM user_custom_alert_rules
     WHERE id = $1
       AND user_id = $2`,
    [ruleId, normalizedUserId]
  );
  const existing = existingRows[0];
  if (!existing) {
    return null;
  }

  const metadata = { ...normalizeMetadata(existing.metadata) };
  const incomingMetadata = normalizeMetadata(payload.metadata);
  for (const key of ['baselineMcap', 'baselinePrice', 'baselineAt']) {
    if (incomingMetadata[key] !== undefined) {
      metadata[key] = incomingMetadata[key];
    }
  }
  const operator = deriveOperator(normalizeOperator(payload.operator), metric, targetValue, metadata);
  let soundName = existing.sound_name || null;
  if (soundDataUrl) {
    metadata.soundDataUrl = soundDataUrl;
    soundName = newSoundName;
  }
  // expiresInHours: undefined keeps the current expiry, null clears it, a number resets it.
  if (payload.expiresInHours !== undefined) {
    const expiresInHours = normalizeExpiresInHours(payload.expiresInHours);
    if (expiresInHours == null) {
      delete metadata.expiresAt;
    } else {
      metadata.expiresAt = buildExpiresAtIso(expiresInHours);
    }
  }

  const { rows } = await runner.query(
    `UPDATE user_custom_alert_rules
     SET title = $3,
         metric = $4,
         operator = $5,
         target_value = $6,
         color_hex = $7,
         sound_name = $8,
         metadata = $9::jsonb,
         status = 'active',
         triggered_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
     RETURNING *`,
    [
      ruleId,
      normalizedUserId,
      title,
      metric,
      operator,
      targetValue,
      colorHex,
      soundName,
      JSON.stringify(metadata),
    ]
  );

  return mapRuleRow(rows[0] || null);
}

async function disableRule(id, userId, runner = db) {
  const ruleId = Number.parseInt(String(id || '').trim(), 10);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw validationError('Valid custom alert rule id is required');
  }
  const normalizedUserId = normalizeUserId(userId);
  const { rows } = await runner.query(
    `UPDATE user_custom_alert_rules
     SET status = 'disabled',
         updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
     RETURNING *`,
    [ruleId, normalizedUserId]
  );

  return mapRuleRow(rows[0] || null);
}

module.exports = {
  VALID_METRICS,
  VALID_OPERATORS,
  VALID_STATUSES,
  createRule,
  disableRule,
  listActiveByTokenAddress,
  listRules,
  markTriggered,
  updateRule,
  __private: {
    buildExpiresAtIso,
    mapRuleRow,
    normalizeAddress,
    normalizeColorHex,
    normalizeExpiresInHours,
    normalizeMetric,
    normalizeOperator,
    normalizeSoundName,
    normalizeSoundDataUrl,
    normalizeStatus,
    normalizeTargetValue,
    normalizeTitle,
    normalizeUserId,
  },
};
