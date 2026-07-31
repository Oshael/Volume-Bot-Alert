const { query } = require('./db');
const {
  buildDefaultRules,
  validateRuleSettings,
} = require('../services/telegram-alert-rule-contracts');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });

function requireEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('Telegram rule enabled state must be boolean');
  }
  return enabled;
}

function serializeSettings(chain, ruleKey, settings) {
  return JSON.stringify(validateRuleSettings(chain, ruleKey, settings));
}

async function create(input, db) {
  const { rows } = await runner(db).query(
    `INSERT INTO telegram_alert_rule_settings (
       profile_id, chain, rule_key, enabled, settings_json
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      input.profileId,
      input.chain,
      input.ruleKey,
      requireEnabled(input.enabled),
      serializeSettings(input.chain, input.ruleKey, input.settings),
    ]
  );
  return rows[0] || null;
}

async function findByProfileAndRule(profileId, ruleKey, db) {
  const { rows } = await runner(db).query(
    `SELECT * FROM telegram_alert_rule_settings
     WHERE profile_id = $1 AND rule_key = $2
     LIMIT 1`,
    [profileId, ruleKey]
  );
  return rows[0] || null;
}

async function listByProfileId(profileId, db) {
  const { rows } = await runner(db).query(
    `SELECT * FROM telegram_alert_rule_settings
     WHERE profile_id = $1
     ORDER BY rule_key`,
    [profileId]
  );
  return rows;
}

async function ensureDefaults(profiles, db) {
  const created = [];
  for (const profile of profiles) {
    const defaults = buildDefaultRules(profile.chain).map((rule) => ({
      rule_key: rule.ruleKey,
      enabled: rule.enabled,
      settings_json: rule.settings,
    }));
    const { rows } = await runner(db).query(
      `INSERT INTO telegram_alert_rule_settings (
         profile_id, chain, rule_key, enabled, settings_json
       )
       SELECT $1, $2, item.rule_key, item.enabled, item.settings_json
       FROM jsonb_to_recordset($3::jsonb)
         AS item(rule_key varchar(64), enabled boolean, settings_json jsonb)
       ON CONFLICT (profile_id, rule_key) DO NOTHING
       RETURNING *`,
      [profile.id, profile.chain, JSON.stringify(defaults)]
    );
    created.push(...rows);
  }
  return created;
}

async function update(input, db) {
  const { rows } = await runner(db).query(
    `UPDATE telegram_alert_rule_settings
     SET enabled = $4,
         settings_json = $5::jsonb,
         version = version + 1,
         updated_at = NOW()
     WHERE profile_id = $1
       AND chain = $2
       AND rule_key = $3
       AND version = $6
     RETURNING *`,
    [
      input.profileId,
      input.chain,
      input.ruleKey,
      requireEnabled(input.enabled),
      serializeSettings(input.chain, input.ruleKey, input.settings),
      input.expectedVersion,
    ]
  );
  return rows[0] || null;
}

module.exports = {
  create,
  ensureDefaults,
  findByProfileAndRule,
  listByProfileId,
  update,
};
