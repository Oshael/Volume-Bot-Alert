'use strict';

const db = require('./db');

const SEVERITIES = new Set(['warning', 'high', 'critical']);
const NOTIFICATION_KINDS = new Set(['incident', 'recovery']);

function database(value) {
  return value && typeof value.query === 'function' ? value : db;
}

function text(value, field, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} must be a timestamp`);
  return parsed.toISOString();
}

function integer(value, field, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeIssue(issue = {}) {
  const severity = text(issue.severity, 'incident severity', 16);
  if (!SEVERITIES.has(severity)) throw new TypeError(`Unsupported incident severity: ${severity}`);
  return {
    incidentKey: text(issue.id, 'incident id', 512),
    componentKey: text(issue.componentKey, 'component key', 128),
    code: text(issue.code, 'incident code', 64),
    severity,
    path: text(issue.path, 'incident path', 512),
    details: issue,
  };
}

function uniqueComponents(values) {
  if (!Array.isArray(values) || values.length > 100) {
    throw new TypeError('evaluated components must be an array with at most 100 entries');
  }
  return [...new Set(values.map((value) => text(value, 'component key', 128)))];
}

function mapIncident(row) {
  if (!row) return null;
  return {
    incidentKey: row.incident_key, componentKey: row.component_key,
    code: row.code, severity: row.severity, path: row.path, status: row.status,
    consecutiveObservations: Number(row.consecutive_observations),
    firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at,
    openedAt: row.opened_at, resolvedAt: row.resolved_at,
    lastNotifiedAt: row.last_notified_at, recoveryNotifiedAt: row.recovery_notified_at,
    notificationCount: Number(row.notification_count),
    notificationNextAttemptAt: row.notification_next_attempt_at,
    notificationKind: row.notification_kind || row.notification_claim_kind || null,
    details: row.details || {}, action: row.action || null,
  };
}

async function reconcile(input = {}, runner) {
  const normalized = Array.isArray(input.issues) ? input.issues.map(normalizeIssue) : [];
  const issues = [...new Map(normalized.map((item) => [item.incidentKey, item])).values()];
  if (issues.length > 500) throw new TypeError('worker health reconciliation supports 500 issues');
  const components = uniqueComponents(input.evaluatedComponents || []);
  const observedAt = timestamp(input.observedAt ?? new Date(), 'observedAt');
  const minimum = integer(input.minimumObservations, 'minimum observations', 2, 1, 10);
  const { rows } = await database(runner).query(
    `WITH observed AS MATERIALIZED (
       SELECT value.*
       FROM jsonb_to_recordset($1::jsonb) AS value(
         incident_key varchar, component_key varchar, code varchar,
         severity varchar, path varchar, details jsonb
       )
       WHERE NOT EXISTS (
         SELECT 1 FROM worker_health_maintenance maintenance
         WHERE maintenance.cancelled_at IS NULL
           AND maintenance.starts_at <= $3::timestamptz
           AND maintenance.ends_at > $3::timestamptz
           AND maintenance.component_key IN (value.component_key, '*')
       )
     ), upserted AS (
       INSERT INTO worker_health_incidents (
         incident_key, component_key, code, severity, path, status,
         first_observed_at, last_observed_at, consecutive_observations,
         opened_at, details
       ) SELECT incident_key, component_key, code, severity, path,
         CASE WHEN $4::int = 1 THEN 'open' ELSE 'observing' END,
         $3, $3, 1, CASE WHEN $4::int = 1 THEN $3 ELSE NULL END, details
       FROM observed
       ON CONFLICT (incident_key) DO UPDATE SET
         component_key = EXCLUDED.component_key, code = EXCLUDED.code,
         severity = EXCLUDED.severity, path = EXCLUDED.path,
         first_observed_at = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN $3 ELSE worker_health_incidents.first_observed_at END,
         last_observed_at = $3,
         consecutive_observations = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN 1 ELSE worker_health_incidents.consecutive_observations + 1 END,
         status = CASE WHEN worker_health_incidents.status = 'open' THEN 'open'
           WHEN (CASE WHEN worker_health_incidents.status = 'resolved' THEN 1
             ELSE worker_health_incidents.consecutive_observations + 1 END) >= $4
             THEN 'open' ELSE 'observing' END,
         opened_at = CASE WHEN worker_health_incidents.status = 'open'
           THEN worker_health_incidents.opened_at
           WHEN (CASE WHEN worker_health_incidents.status = 'resolved' THEN 1
             ELSE worker_health_incidents.consecutive_observations + 1 END) >= $4
             THEN $3 ELSE NULL END,
         resolved_at = NULL,
         last_notified_at = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN NULL ELSE worker_health_incidents.last_notified_at END,
         recovery_notified_at = NULL,
         notification_next_attempt_at = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN NOW() ELSE worker_health_incidents.notification_next_attempt_at END,
         notification_claim_kind = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN NULL ELSE worker_health_incidents.notification_claim_kind END,
         notification_claim_owner = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN NULL ELSE worker_health_incidents.notification_claim_owner END,
         notification_claim_until = CASE WHEN worker_health_incidents.status = 'resolved'
           THEN NULL ELSE worker_health_incidents.notification_claim_until END,
         details = EXCLUDED.details, updated_at = NOW()
       RETURNING worker_health_incidents.*, 'observed'::text AS action
     ), discarded AS (
       DELETE FROM worker_health_incidents incidents
       WHERE incidents.status = 'observing' AND incidents.component_key = ANY($2::varchar[])
         AND NOT EXISTS (SELECT 1 FROM observed WHERE incident_key = incidents.incident_key)
         AND NOT EXISTS (SELECT 1 FROM worker_health_maintenance maintenance
           WHERE maintenance.cancelled_at IS NULL AND maintenance.starts_at <= $3
             AND maintenance.ends_at > $3
             AND maintenance.component_key IN (incidents.component_key, '*'))
     ), resolved AS (
       UPDATE worker_health_incidents incidents
       SET status = 'resolved', resolved_at = $3, updated_at = NOW(),
           notification_claim_kind = NULL, notification_claim_owner = NULL,
           notification_claim_until = NULL
       WHERE incidents.status = 'open' AND incidents.component_key = ANY($2::varchar[])
         AND NOT EXISTS (SELECT 1 FROM observed WHERE incident_key = incidents.incident_key)
         AND NOT EXISTS (SELECT 1 FROM worker_health_maintenance maintenance
           WHERE maintenance.cancelled_at IS NULL AND maintenance.starts_at <= $3
             AND maintenance.ends_at > $3
             AND maintenance.component_key IN (incidents.component_key, '*'))
       RETURNING incidents.*, 'resolved'::text AS action
     ) SELECT * FROM upserted UNION ALL SELECT * FROM resolved`,
    [JSON.stringify(issues.map((issue) => ({
      incident_key: issue.incidentKey, component_key: issue.componentKey,
      code: issue.code, severity: issue.severity, path: issue.path, details: issue.details,
    }))), components, observedAt, minimum]
  );
  return rows.map(mapIncident);
}

async function claimNotifications(input = {}, runner) {
  const owner = text(input.owner, 'notification owner', 128);
  const limit = integer(input.limit, 'notification claim limit', 25, 1, 100);
  const leaseMs = integer(input.leaseMs, 'notification lease', 60_000, 1_000, 600_000);
  const cooldownMs = integer(input.cooldownMs, 'notification cooldown', 3_600_000, 1_000, 86_400_000);
  const { rows } = await database(runner).query(
    `WITH claimable AS MATERIALIZED (
       SELECT incidents.incident_key,
         CASE WHEN incidents.status = 'resolved' THEN 'recovery' ELSE 'incident' END AS kind
       FROM worker_health_incidents incidents
       WHERE (incidents.notification_claim_until IS NULL
           OR incidents.notification_claim_until <= NOW())
         AND incidents.notification_next_attempt_at <= NOW()
         AND ((incidents.status = 'open' AND (incidents.last_notified_at IS NULL
              OR incidents.last_notified_at <= NOW() - ($4::int * INTERVAL '1 millisecond')))
           OR (incidents.status = 'resolved' AND incidents.opened_at IS NOT NULL
              AND incidents.recovery_notified_at IS NULL))
         AND NOT EXISTS (SELECT 1 FROM worker_health_maintenance maintenance
           WHERE maintenance.cancelled_at IS NULL AND maintenance.starts_at <= NOW()
             AND maintenance.ends_at > NOW()
             AND maintenance.component_key IN (incidents.component_key, '*'))
       ORDER BY CASE incidents.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
         incidents.first_observed_at
       LIMIT $1 FOR UPDATE SKIP LOCKED
     ) UPDATE worker_health_incidents incidents
       SET notification_claim_kind = claimable.kind, notification_claim_owner = $2,
           notification_claim_until = NOW() + ($3::int * INTERVAL '1 millisecond'),
           updated_at = NOW()
       FROM claimable WHERE incidents.incident_key = claimable.incident_key
       RETURNING incidents.*, claimable.kind AS notification_kind`,
    [limit, owner, leaseMs, cooldownMs]
  );
  return rows.map(mapIncident);
}

async function settleNotification(input = {}, sent, runner) {
  const kind = text(input.kind, 'notification kind', 16);
  if (!NOTIFICATION_KINDS.has(kind)) throw new TypeError(`Unsupported notification kind: ${kind}`);
  const retryMs = integer(input.retryMs, 'notification retry', 30_000, 1_000, 600_000);
  const { rows } = await database(runner).query(
    `UPDATE worker_health_incidents SET
       last_notified_at = CASE WHEN $3::boolean AND $4 = 'incident' THEN NOW()
         ELSE last_notified_at END,
       recovery_notified_at = CASE WHEN $3::boolean AND $4 = 'recovery' THEN NOW()
         ELSE recovery_notified_at END,
       notification_count = notification_count
         + CASE WHEN $3::boolean AND $4 = 'incident' THEN 1 ELSE 0 END,
       notification_next_attempt_at = CASE WHEN $3::boolean THEN NOW()
         ELSE NOW() + ($5::int * INTERVAL '1 millisecond') END,
       notification_claim_kind = NULL, notification_claim_owner = NULL,
       notification_claim_until = NULL, updated_at = NOW()
     WHERE incident_key = $1 AND notification_claim_owner = $2
       AND notification_claim_kind = $4 AND notification_claim_until > NOW()
     RETURNING *`,
    [text(input.incidentKey, 'incident key', 512), text(input.owner, 'notification owner', 128),
      sent === true, kind, retryMs]
  );
  return mapIncident(rows[0]);
}

async function scheduleMaintenance(input = {}, runner) {
  const { rows } = await database(runner).query(
    `INSERT INTO worker_health_maintenance (
       component_key, reason, created_by, starts_at, ends_at
     ) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [text(input.componentKey, 'component key', 128), text(input.reason, 'reason', 500),
      text(input.createdBy, 'created by', 128), timestamp(input.startsAt, 'startsAt'),
      timestamp(input.endsAt, 'endsAt')]
  );
  return rows[0];
}

async function cancelMaintenance(id, runner) {
  const { rows } = await database(runner).query(
    `UPDATE worker_health_maintenance SET cancelled_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND cancelled_at IS NULL RETURNING *`,
    [integer(id, 'maintenance id', undefined, 1, Number.MAX_SAFE_INTEGER)]
  );
  return rows[0] || null;
}

module.exports = {
  cancelMaintenance, claimNotifications, reconcile, scheduleMaintenance,
  markNotificationSent: (input, runner) => settleNotification(input, true, runner),
  releaseNotificationClaim: (input, runner) => settleNotification(input, false, runner),
};
