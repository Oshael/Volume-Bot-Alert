const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');
const {
  CAPABILITY_MATRIX,
  ERROR_CODES,
  SPOT_WINDOW,
  evaluateCustomAlertCapability,
  getCustomAlertCapability,
} = require('../services/custom-alert-capability-policy');
const {
  assertAutomaticAlertPublicationAuthorized,
} = require('../services/automatic-alert-publication-guard');

const VALID_METRICS = new Set(Object.values(CAPABILITY_MATRIX).flatMap(({ metrics }) => metrics));
const VALID_OPERATORS = new Set(['cross_above', 'cross_below']);
const VALID_STATUSES = new Set(['active', 'triggered', 'disabled']);
const MAX_SOUND_DATA_URL_LENGTH = 7 * 1024 * 1024;

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function capabilityError(result) {
  const labels = {
    [ERROR_CODES.chainUnsupported]: 'Custom alert chain is unsupported',
    [ERROR_CODES.metricUnsupported]: 'Custom alert metric is unsupported for this chain',
    [ERROR_CODES.windowUnsupported]: 'Custom alert window is unsupported for this chain',
    [ERROR_CODES.notReady]: 'Custom alerts are not ready for this chain',
  };
  return Object.assign(validationError(labels[result.code] || 'Invalid custom alert capability'), {
    code: result.code,
    reason: result.reason,
    capability: result.capability,
  });
}

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw validationError('Valid user id is required');
  }
  return userId;
}

function normalizeIdentity(address, chainValue = 'solana') {
  try {
    const chain = normalizeTokenChain(chainValue);
    return { chain, address: normalizeTokenAddress(chain, address) };
  } catch (error) {
    throw validationError(error.message);
  }
}

function assertAutomaticTriggerEnabled(chain, authorization) {
  if (chain === 'solana') return;
  try {
    assertAutomaticAlertPublicationAuthorized(authorization, chain);
  } catch (_) {
    const error = validationError('Custom alert triggering is disabled outside Solana');
    error.code = 'NON_SOLANA_CUSTOM_ALERT_TRIGGER_DISABLED';
    throw error;
  }
}

function normalizeTitle(value) {
  const title = String(value || '').trim() || 'Custom alert';
  return title.slice(0, 64);
}

function normalizeRuleCapability(chain, metric, window) {
  const result = evaluateCustomAlertCapability({ chain, metric, window, ready: true });
  if (!result.ok) throw capabilityError(result);
  return { metric: result.metric, window: result.window };
}

function normalizeMetric(value, chain = 'solana', window = SPOT_WINDOW) {
  return normalizeRuleCapability(chain, value, window).metric;
}

function normalizeFilterChains(filters = {}) {
  const requested = Array.isArray(filters.chains)
    ? filters.chains
    : [filters.chain || 'solana'];
  if (requested.length === 0) {
    throw capabilityError(evaluateCustomAlertCapability({ chain: null, ready: true }));
  }
  return [...new Set(requested.map((value) => {
    const capability = getCustomAlertCapability({ chain: value, ready: true });
    if (!capability.supported) {
      throw capabilityError(evaluateCustomAlertCapability({ chain: value, ready: true }));
    }
    return capability.chain;
  }))];
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
  const baselineKeys = { price: 'baselinePrice', mcap: 'baselineMcap', fdv: 'baselineFdv' };
  const baseline = Number(metadata?.[baselineKeys[metric]]);
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
    chain: row.chain || 'solana',
    tokenAddress: row.token_address || null,
    title: row.title || null,
    metric: row.metric || null,
    window: row.window || SPOT_WINDOW,
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
  const identity = normalizeIdentity(payload.tokenAddress, payload.chain || 'solana');
  const title = normalizeTitle(payload.title);
  const { metric, window } = normalizeRuleCapability(identity.chain, payload.metric, payload.window);
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
       chain,
       token_address,
       title,
       metric,
       operator,
       target_value,
       color_hex,
       sound_name,
       metadata,
       "window"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING *`,
    [
      normalizedUserId,
      identity.chain,
      identity.address,
      title,
      metric,
      operator,
      targetValue,
      colorHex,
      soundName,
      JSON.stringify(storedMetadata),
      window,
    ]
  );

  return mapRuleRow(rows[0] || null);
}

async function listRules(userId, filters = {}, runner = db) {
  const normalizedUserId = normalizeUserId(userId);
  const chains = normalizeFilterChains(filters);
  const values = [normalizedUserId, chains];
  const clauses = ['user_id = $1', 'chain = ANY($2::text[])'];
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

async function listActiveByTokenIdentity(identityValue, runner = db) {
  let identity;
  try {
    identity = normalizeIdentity(identityValue?.address, identityValue?.chain);
    if (!getCustomAlertCapability({ chain: identity.chain, ready: true }).supported) return [];
  } catch (_) {
    return [];
  }
  const { rows } = await runner.query(
    `SELECT *
     FROM user_custom_alert_rules
     WHERE chain = $1
       AND token_address = $2
       AND status = 'active'
       AND (metadata->>'expiresAt' IS NULL OR (metadata->>'expiresAt')::timestamptz > NOW())
     ORDER BY updated_at ASC, id ASC`,
    [identity.chain, identity.address]
  );

  return rows.map(mapRuleRow);
}

async function listActiveByTokenIdentities(identityValues, runner = db) {
  const identities = [...new Map((Array.isArray(identityValues) ? identityValues : [])
    .map((value) => normalizeIdentity(value?.address, value?.chain))
    .map((identity) => [`${identity.chain}:${identity.address}`, identity])).values()];
  if (!identities.length) return [];
  const { rows } = await runner.query(
    `SELECT rules.*
     FROM user_custom_alert_rules rules
     INNER JOIN UNNEST($1::text[], $2::text[]) AS identity(chain, address)
       ON identity.chain = rules.chain
      AND identity.address = rules.token_address
     WHERE rules.status = 'active'
       AND (rules.metadata->>'expiresAt' IS NULL
         OR (rules.metadata->>'expiresAt')::timestamptz > NOW())
     ORDER BY rules.updated_at ASC, rules.id ASC`,
    [identities.map(({ chain }) => chain), identities.map(({ address }) => address)]
  );
  return rows.map(mapRuleRow);
}

async function listActiveByTokenAddress(tokenAddress, runner = db, chainValue = 'solana') {
  return listActiveByTokenIdentity({ chain: chainValue, address: tokenAddress }, runner);
}

async function markTriggered(id, userId, options = {}, runner = db) {
  const ruleId = Number.parseInt(String(id || '').trim(), 10);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw validationError('Valid custom alert rule id is required');
  }
  const normalizedUserId = normalizeUserId(userId);
  const chain = normalizeTokenChain(options.chain || 'solana');
  assertAutomaticTriggerEnabled(chain, options.authorization);
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
       AND chain = $4
       AND status = 'active'
     RETURNING *`,
    [ruleId, normalizedUserId, triggeredAt, chain]
  );

  return mapRuleRow(rows[0] || null);
}

async function updateRule(id, userId, payload = {}, runner = db) {
  const ruleId = Number.parseInt(String(id || '').trim(), 10);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw validationError('Valid custom alert rule id is required');
  }
  const normalizedUserId = normalizeUserId(userId);
  const chain = normalizeFilterChains({ chain: payload.chain || 'solana' })[0];
  const title = normalizeTitle(payload.title);
  const { metric, window } = normalizeRuleCapability(chain, payload.metric, payload.window);
  const targetValue = normalizeTargetValue(payload.targetValue ?? payload.target);
  const colorHex = normalizeColorHex(payload.colorHex);
  const newSoundName = normalizeSoundName(payload.soundName);
  const soundDataUrl = normalizeSoundDataUrl(payload.soundDataUrl);

  const { rows: existingRows } = await runner.query(
    `SELECT metadata, sound_name
     FROM user_custom_alert_rules
     WHERE id = $1
       AND user_id = $2
       AND chain = $3`,
    [ruleId, normalizedUserId, chain]
  );
  const existing = existingRows[0];
  if (!existing) {
    return null;
  }

  const metadata = { ...normalizeMetadata(existing.metadata) };
  const incomingMetadata = normalizeMetadata(payload.metadata);
  for (const key of ['baselineMcap', 'baselinePrice', 'baselineFdv', 'baselineAt']) {
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
         "window" = $10,
         status = 'active',
         triggered_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND chain = $11
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
      window,
      chain,
    ]
  );

  return mapRuleRow(rows[0] || null);
}

async function disableRule(id, userId, options = {}, runner = db) {
  const ruleId = Number.parseInt(String(id || '').trim(), 10);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw validationError('Valid custom alert rule id is required');
  }
  const normalizedUserId = normalizeUserId(userId);
  const chain = normalizeFilterChains({ chain: options.chain || 'solana' })[0];
  const { rows } = await runner.query(
    `UPDATE user_custom_alert_rules
     SET status = 'disabled',
         updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND chain = $3
     RETURNING *`,
    [ruleId, normalizedUserId, chain]
  );

  return mapRuleRow(rows[0] || null);
}

module.exports = {
  VALID_METRICS,
  VALID_OPERATORS,
  VALID_STATUSES,
  createRule,
  disableRule,
  listActiveByTokenIdentities,
  listActiveByTokenIdentity,
  listActiveByTokenAddress,
  listRules,
  markTriggered,
  updateRule,
  __private: {
    buildExpiresAtIso,
    mapRuleRow,
    normalizeIdentity,
    normalizeFilterChains,
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
