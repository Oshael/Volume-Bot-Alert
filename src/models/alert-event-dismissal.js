const db = require('./db');
const { normalizeTokenChain } = require('../utils/token-identity');

function normalizePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} is required`);
  return parsed;
}

function normalizeRuleKey(value) {
  const ruleKey = String(value || '').trim().toLowerCase();
  if (!ruleKey || ruleKey.length > 64) throw new Error('Valid alert rule key is required');
  return ruleKey;
}

function mapDismissalRow(row) {
  if (!row) return null;
  return {
    userId: Number(row.user_id) || null,
    ruleKey: row.rule_key || null,
    chain: row.chain || null,
    eventId: Number(row.event_id) || null,
    dismissedAt: row.dismissed_at || null,
  };
}

async function dismissEvent(payload = {}, runner = db) {
  const normalized = {
    userId: normalizePositiveInteger(payload.userId, 'User id'),
    ruleKey: normalizeRuleKey(payload.ruleKey),
    chain: normalizeTokenChain(payload.chain),
    eventId: normalizePositiveInteger(payload.eventId, 'Alert event id'),
  };
  const { rows } = await runner.query(
    `INSERT INTO alert_event_dismissals (
       user_id, rule_key, chain, event_id, dismissed_at
     )
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, rule_key, chain, event_id) DO UPDATE SET
       dismissed_at = alert_event_dismissals.dismissed_at
     RETURNING *`,
    [normalized.userId, normalized.ruleKey, normalized.chain, normalized.eventId]
  );
  return mapDismissalRow(rows[0] || null);
}

module.exports = {
  dismissEvent,
  __private: { mapDismissalRow, normalizePositiveInteger, normalizeRuleKey },
};
