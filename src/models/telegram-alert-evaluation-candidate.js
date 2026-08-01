const { query } = require('./db');

const CHAINS = new Set(['solana', 'robinhood']);
const runner = (db) => (db && typeof db.query === 'function' ? db : { query });

function requireChain(chain) {
  if (!CHAINS.has(chain)) {
    throw new TypeError(`Unsupported Telegram alert chain: ${chain}`);
  }
  return chain;
}

function createCandidate(row) {
  return {
    profile: {
      id: row.profile_id,
      user_id: row.user_id,
      connection_id: row.connection_id,
      chain: row.chain,
      enabled: row.profile_enabled,
      sparkline_enabled: row.sparkline_enabled,
      version: row.profile_version,
      updated_at: row.profile_updated_at,
    },
    user: {
      id: row.user_id,
      role: row.user_role,
      is_active: row.user_is_active,
      access_status: row.access_status,
      access_granted_at: row.access_granted_at,
      access_expires_at: row.access_expires_at,
      access_source: row.access_source,
      access_updated_at: row.access_updated_at,
    },
    reactivation: {
      status: row.connection_status,
      requested_at: row.access_reactivation_requested_at,
      reactivated_at: row.access_reactivated_at,
    },
    rules: [],
  };
}

function createRule(row) {
  return {
    profile_id: row.profile_id,
    chain: row.chain,
    rule_key: row.rule_key,
    enabled: row.rule_enabled,
    settings_json: row.settings_json,
    version: row.rule_version,
    updated_at: row.rule_updated_at,
  };
}

function groupRows(rows) {
  const candidates = new Map();
  for (const row of rows) {
    const key = String(row.profile_id);
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = createCandidate(row);
      candidates.set(key, candidate);
    }
    candidate.rules.push(createRule(row));
  }
  return [...candidates.values()];
}

async function listByChain(chain, db) {
  const { rows } = await runner(db).query(
    `SELECT
       profiles.id AS profile_id,
       profiles.user_id,
       profiles.connection_id,
       profiles.chain,
       profiles.enabled AS profile_enabled,
       profiles.sparkline_enabled,
       profiles.version AS profile_version,
       profiles.updated_at AS profile_updated_at,
       connections.status AS connection_status,
       connections.access_reactivation_requested_at,
       connections.access_reactivated_at,
       users.role AS user_role,
       users.is_active AS user_is_active,
       users.access_status,
       users.access_granted_at,
       users.access_expires_at,
       users.access_source,
       users.access_updated_at,
       rules.rule_key,
       rules.enabled AS rule_enabled,
       rules.settings_json,
       rules.version AS rule_version,
       rules.updated_at AS rule_updated_at
     FROM telegram_alert_profiles profiles
     JOIN telegram_connections connections
       ON connections.id = profiles.connection_id
      AND connections.user_id = profiles.user_id
     JOIN users
       ON users.id = profiles.user_id
     JOIN telegram_alert_rule_settings rules
       ON rules.profile_id = profiles.id
      AND rules.chain = profiles.chain
     WHERE profiles.chain = $1
       AND profiles.enabled = TRUE
       AND (
         connections.status = 'active'
         OR (
           connections.status = 'access_suspended'
           AND connections.access_reactivation_requested_at IS NOT NULL
         )
       )
       AND users.is_active = TRUE
     ORDER BY profiles.id, rules.rule_key`,
    [requireChain(chain)]
  );
  return groupRows(rows);
}

module.exports = {
  listByChain,
  __private: {
    groupRows,
  },
};
