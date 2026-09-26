'use strict';

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const db = require('../models/db');
const { sqlLabel } = require('../models/postgres-pool-holder-telemetry');

const ACTIVITY_SQL = `SELECT pid, application_name, state, wait_event_type, wait_event,
    EXTRACT(EPOCH FROM clock_timestamp() - query_start) * 1000 AS query_ms,
    pg_blocking_pids(pid) AS blockers, LEFT(query, 240) AS query
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
    AND state <> 'idle'
  ORDER BY query_start NULLS LAST LIMIT 20`;

async function readActivity(pool = db.pool, ClientClass = Client) {
  const client = new ClientClass({
    ...pool.options,
    ...(pool.options.password === undefined ? {} : { password: pool.options.password }),
    application_name: 'robinhood-deployment-lag-recorder',
    connectionTimeoutMillis: 1000, query_timeout: 1500, statement_timeout: 1000,
  });
  const startedAt = Date.now();
  try {
    await client.connect();
    const { rows } = await client.query(ACTIVITY_SQL);
    return {
      sampledAt: new Date().toISOString(), delayMs: Date.now() - startedAt,
      sessions: rows.map((row) => ({
        pid: row.pid, applicationName: row.application_name, state: row.state,
        wait: row.wait_event_type ? `${row.wait_event_type}:${row.wait_event}` : null,
        queryMs: Math.round(Number(row.query_ms) || 0), blockers: row.blockers,
        sql: sqlLabel(row.query),
      })),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

function createRobinhoodDeploymentLagRecorder(deps = {}) {
  const now = deps.now || Date.now;
  const logger = deps.logger || console.warn;
  const activityProbe = deps.activityProbe || (() => readActivity(deps.pool));
  const cooldownMs = deps.cooldownMs ?? 30_000;
  const lastByKind = new Map();
  const suppressed = new Map();
  const awaitingActivity = [];
  let probing = false;

  function emit(value) {
    try { logger(`[RobinhoodDeploymentLag] ${JSON.stringify(value)}`); }
    catch (_) { /* Diagnostic logging must never block the live worker. */ }
  }

  function record(kind, snapshot) {
    const at = now();
    if (at - (lastByKind.get(kind) ?? -Infinity) < cooldownMs) {
      suppressed.set(kind, (suppressed.get(kind) || 0) + 1);
      return false;
    }
    lastByKind.set(kind, at);
    const id = randomUUID();
    try {
      const evidence = typeof snapshot === 'function' ? snapshot() : snapshot;
      emit({ id, event: 'snapshot', kind, at: new Date(at).toISOString(),
        suppressed: suppressed.get(kind) || 0, ...evidence });
    } catch (error) {
      emit({ id, event: 'snapshot_error', kind, message: error.message });
    }
    suppressed.set(kind, 0);
    awaitingActivity.push({ id, kind });
    if (probing) return true;
    probing = true;
    Promise.resolve().then(activityProbe).then((activity) => {
      for (const incident of awaitingActivity) {
        emit({ ...incident, event: 'postgres_activity', activity });
      }
    }).catch((error) => {
      for (const incident of awaitingActivity) {
        emit({ ...incident, event: 'postgres_activity_error',
          code: error.code || null, message: error.message });
      }
    }).finally(() => { awaitingActivity.length = 0; probing = false; });
    return true;
  }

  return Object.freeze({ record });
}

module.exports = { createRobinhoodDeploymentLagRecorder, readActivity };
