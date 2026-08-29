/** Stage 176 - durable worker-health incidents and planned maintenance. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS worker_health_incidents (
     incident_key VARCHAR(512) PRIMARY KEY,
     component_key VARCHAR(128) NOT NULL,
     code VARCHAR(64) NOT NULL,
     severity VARCHAR(16) NOT NULL,
     path VARCHAR(512) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'observing',
     first_observed_at TIMESTAMPTZ NOT NULL,
     last_observed_at TIMESTAMPTZ NOT NULL,
     consecutive_observations INTEGER NOT NULL DEFAULT 1,
     opened_at TIMESTAMPTZ,
     resolved_at TIMESTAMPTZ,
     last_notified_at TIMESTAMPTZ,
     recovery_notified_at TIMESTAMPTZ,
     notification_count INTEGER NOT NULL DEFAULT 0,
     notification_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     notification_claim_kind VARCHAR(16),
     notification_claim_owner VARCHAR(128),
     notification_claim_until TIMESTAMPTZ,
     details JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT worker_health_incidents_severity_check CHECK (
       severity IN ('warning', 'high', 'critical')
     ),
     CONSTRAINT worker_health_incidents_status_check CHECK (
       status IN ('observing', 'open', 'resolved')
     ),
     CONSTRAINT worker_health_incidents_observation_check CHECK (
       consecutive_observations >= 1 AND notification_count >= 0
       AND last_observed_at >= first_observed_at
       AND (status = 'observing' OR opened_at IS NOT NULL)
       AND (status = 'resolved') = (resolved_at IS NOT NULL)
     ),
     CONSTRAINT worker_health_incidents_claim_check CHECK (
       (notification_claim_kind IS NULL AND notification_claim_owner IS NULL
         AND notification_claim_until IS NULL)
       OR (notification_claim_kind IN ('incident', 'recovery')
         AND notification_claim_owner IS NOT NULL AND notification_claim_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_worker_health_incidents_notify
     ON worker_health_incidents(status, last_notified_at, recovery_notified_at)
     WHERE status IN ('open', 'resolved')`,
  `CREATE INDEX IF NOT EXISTS idx_worker_health_incidents_component
     ON worker_health_incidents(component_key, status)`,
  `CREATE TABLE IF NOT EXISTS worker_health_maintenance (
     id BIGSERIAL PRIMARY KEY,
     component_key VARCHAR(128) NOT NULL,
     reason VARCHAR(500) NOT NULL,
     created_by VARCHAR(128) NOT NULL,
     starts_at TIMESTAMPTZ NOT NULL,
     ends_at TIMESTAMPTZ NOT NULL,
     cancelled_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT worker_health_maintenance_window_check CHECK (ends_at > starts_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_worker_health_maintenance_active
     ON worker_health_maintenance(component_key, starts_at, ends_at)
     WHERE cancelled_at IS NULL`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 176 worker-health control plane created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 176:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
