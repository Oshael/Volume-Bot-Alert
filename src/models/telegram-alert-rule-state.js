const { query } = require('./db');
const { RULE_CONTRACTS } = require('../services/telegram-alert-rule-contracts');
const { normalizeTokenAddress } = require('../utils/token-identity');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });

function positiveId(value, field) {
  let normalized;
  try {
    normalized = BigInt(String(value ?? '').trim());
  } catch (_) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  if (normalized <= 0n) throw new TypeError(`${field} must be a positive integer`);
  return normalized.toString();
}

function positiveVersion(value, field, optional = false) {
  if (optional && value == null) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return normalized;
}

function identity(input) {
  const chain = String(input.chain || '').trim();
  const ruleKey = String(input.ruleKey || '').trim();
  if (!RULE_CONTRACTS[chain]?.[ruleKey]) {
    throw new TypeError(`Unsupported Telegram alert rule: ${chain}/${ruleKey}`);
  }
  return {
    profileId: positiveId(input.profileId, 'profile id'),
    chain,
    ruleKey,
    tokenAddress: normalizeTokenAddress(chain, input.tokenAddress),
  };
}

function serializeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Telegram alert rule state must be an object');
  }
  return JSON.stringify(value);
}

function mapRow(row) {
  if (!row) return null;
  return {
    profileId: String(row.profile_id),
    chain: row.chain,
    ruleKey: row.rule_key,
    tokenAddress: row.token_address,
    ruleVersion: Number(row.rule_version),
    state: row.state_json,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function find(input, db, lock = false) {
  const key = identity(input);
  const { rows } = await runner(db).query(
    `SELECT *
     FROM telegram_alert_rule_states
     WHERE profile_id = $1
       AND chain = $2
       AND rule_key = $3
       AND token_address = $4
     LIMIT 1${lock ? '\n     FOR UPDATE' : ''}`,
    [key.profileId, key.chain, key.ruleKey, key.tokenAddress]
  );
  return mapRow(rows[0] || null);
}

async function findForUpdate(input, db) {
  return find(input, db, true);
}

async function listByProfileAndToken(input, db) {
  const chain = String(input.chain || '').trim();
  const requestedRuleKeys = input.ruleKeys == null
    ? Object.keys(RULE_CONTRACTS[chain] || {})
    : input.ruleKeys;
  if (!Array.isArray(requestedRuleKeys)) {
    throw new TypeError('Telegram alert rule keys must be an array');
  }
  const ruleKeys = [...new Set(requestedRuleKeys.map((ruleKey) => {
    const normalized = String(ruleKey || '').trim();
    if (!RULE_CONTRACTS[chain]?.[normalized]) {
      throw new TypeError(`Unsupported Telegram alert rule: ${chain}/${normalized}`);
    }
    return normalized;
  }))];
  if (!ruleKeys.length) return [];
  const key = identity({ ...input, chain, ruleKey: ruleKeys[0] });
  const { rows } = await runner(db).query(
    `SELECT *
     FROM telegram_alert_rule_states
     WHERE profile_id = $1
       AND chain = $2
       AND token_address = $3
       AND rule_key = ANY($4::varchar[])
     ORDER BY rule_key`,
    [key.profileId, key.chain, key.tokenAddress, ruleKeys]
  );
  return rows.map(mapRow);
}

async function write(input, db) {
  const key = identity(input);
  const { rows } = await runner(db).query(
    `INSERT INTO telegram_alert_rule_states (
       profile_id, chain, rule_key, token_address, rule_version, state_json
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (profile_id, rule_key, token_address) DO UPDATE
     SET rule_version = EXCLUDED.rule_version,
         state_json = EXCLUDED.state_json,
         version = telegram_alert_rule_states.version + 1,
         updated_at = NOW()
     WHERE $7::integer IS NOT NULL
       AND telegram_alert_rule_states.version = $7
     RETURNING *`,
    [
      key.profileId,
      key.chain,
      key.ruleKey,
      key.tokenAddress,
      positiveVersion(input.ruleVersion, 'rule version'),
      serializeState(input.state),
      positiveVersion(input.expectedVersion, 'expected state version', true),
    ]
  );
  return mapRow(rows[0] || null);
}

module.exports = {
  find,
  findForUpdate,
  listByProfileAndToken,
  write,
};
