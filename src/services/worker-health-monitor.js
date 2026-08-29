'use strict';

const { randomUUID } = require('node:crypto');
const os = require('node:os');
const db = require('../models/db');
const workerLease = require('../models/worker-lease');
const incidentStore = require('../models/worker-health-incident');
const { evaluateWorkerHealth } = require('./worker-health-evaluator');
const { listWorkerHealthDefinitions } = require('./worker-health-registry');
const { createWorkerHealthTelegramNotifier } = require('./worker-health-telegram-notifier');

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const CONTROL_PLANE = Object.freeze({
  key: 'worker-health-monitor', label: 'Worker health monitor',
  group: 'core', groups: ['core'], thresholds: {},
});

function healthIssue(code, severity, path, observedValue, threshold) {
  return {
    id: `${CONTROL_PLANE.key}:${path}:${code}`, componentKey: CONTROL_PLANE.key,
    componentLabel: CONTROL_PLANE.label, group: CONTROL_PLANE.group,
    allowedGroups: CONTROL_PLANE.groups, code, severity, path, observedValue, threshold,
  };
}

function createWorkerHealthMonitor(options = {}, deps = {}) {
  const definitions = deps.definitions || listWorkerHealthDefinitions();
  const leases = deps.leaseStore || workerLease;
  const incidents = deps.incidentStore || incidentStore;
  const evaluate = deps.evaluate || evaluateWorkerHealth;
  const notifier = deps.notifier || createWorkerHealthTelegramNotifier(options.telegram);
  const database = deps.database || db;
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const now = deps.now || Date.now;
  const configuredExpected = new Set(options.expectedComponents || []);
  const knownKeys = new Set(definitions.map(({ key }) => key));
  const unknownExpected = [...configuredExpected].filter((key) => !knownKeys.has(key));
  if (unknownExpected.length) {
    throw new TypeError(`Unknown expected worker components: ${unknownExpected.join(', ')}`);
  }
  const localExpected = options.expectedComponentsProvider || (() => []);
  const intervalMs = positiveInteger(options.intervalMs, 30_000);
  const minimumObservations = positiveInteger(options.minimumObservations, 2);
  const cooldownMs = positiveInteger(options.cooldownMs, 3_600_000);
  const retryMs = positiveInteger(options.retryMs, 30_000);
  const runtimeThresholds = options.runtimeThresholds || {};
  const maxDatabaseLatencyMs = positiveInteger(options.maxDatabaseLatencyMs, 2_000);
  const maxPoolWaiting = positiveInteger(options.maxPoolWaiting, 2);
  const maxPoolSaturationPercent = positiveInteger(options.maxPoolSaturationPercent, 90);
  const maxLongTransactionMs = positiveInteger(options.maxLongTransactionMs, 300_000);
  const maxWalBytesPerMinute = positiveInteger(options.maxWalBytesPerMinute, 1024 ** 3);
  const monotonicNow = deps.monotonicNow || Date.now;
  const owner = String(options.owner || `worker-health:${os.hostname()}:${process.pid}:${randomUUID()}`);
  let running = false;
  let timer = null;
  let work = Promise.resolve();
  let controlPlaneFailure = null;
  let previousWal = null;
  const status = {
    running: false, cycles: 0, lastStartedAt: null, lastCompletedAt: null,
    lastError: null, lastIssueCount: 0, lastClaimCount: 0,
  };

  function expectedKeys() {
    return new Set([...configuredExpected, ...localExpected()]);
  }

  async function deliver(claim) {
    const kind = claim.notificationKind;
    try {
      if (kind === 'recovery') await notifier.sendRecovery(claim);
      else await notifier.sendIncident(claim);
      await incidents.markNotificationSent({
        incidentKey: claim.incidentKey, owner, kind,
      });
    } catch (error) {
      await incidents.releaseNotificationClaim({
        incidentKey: claim.incidentKey, owner, kind, retryMs,
      }).catch(() => {});
      throw error;
    }
  }

  function databaseIssues(latencyMs) {
    const output = [];
    if (latencyMs > maxDatabaseLatencyMs) {
      output.push(healthIssue('database_latency_high', 'high', 'database.latencyMs',
        latencyMs, maxDatabaseLatencyMs));
    }
    const waiting = Number(database.pool?.waitingCount || 0);
    const total = Number(database.pool?.totalCount || 0);
    const idle = Number(database.pool?.idleCount || 0);
    const poolMax = Number(database.pool?.options?.max || 0);
    const saturation = poolMax > 0 ? (total - idle) / poolMax * 100 : 0;
    if (waiting >= maxPoolWaiting || saturation >= maxPoolSaturationPercent) {
      output.push(healthIssue('database_pool_pressure', 'high', 'database.pool',
        { waiting, total, idle, saturationPercent: saturation },
        { maxWaiting: maxPoolWaiting, maxSaturationPercent: maxPoolSaturationPercent }));
    }
    return output;
  }

  async function probeDatabase() {
    try {
      const { rows } = await database.query(
        `SELECT COALESCE((SELECT wal_bytes::numeric FROM pg_stat_wal), 0)::text AS wal_bytes,
          COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - xact_start)) * 1000)
            FILTER (WHERE state = 'idle in transaction'), 0)::float8 AS oldest_idle_ms,
          COUNT(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS blocked_queries
         FROM pg_stat_activity WHERE datname = current_database()`
      );
      const sample = rows[0] || {};
      const output = [];
      const oldest = Number(sample.oldest_idle_ms || 0);
      const blocked = Number(sample.blocked_queries || 0);
      if (oldest > maxLongTransactionMs) output.push(healthIssue(
        'database_long_transaction', 'high', 'database.oldestIdleTransactionMs',
        oldest, maxLongTransactionMs,
      ));
      if (blocked > 0) output.push(healthIssue(
        'database_blocked_queries', 'high', 'database.blockedQueries', blocked, 0,
      ));
      const walBytes = Number(sample.wal_bytes);
      const capturedAt = now();
      if (previousWal && Number.isFinite(walBytes) && capturedAt > previousWal.capturedAt) {
        const rate = Math.max(0, walBytes - previousWal.bytes)
          / (capturedAt - previousWal.capturedAt) * 60_000;
        if (rate > maxWalBytesPerMinute) output.push(healthIssue(
          'wal_growth_high', 'warning', 'database.walBytesPerMinute', rate,
          maxWalBytesPerMinute,
        ));
      }
      if (Number.isFinite(walBytes)) previousWal = { bytes: walBytes, capturedAt };
      return output;
    } catch (_) {
      return [healthIssue('database_probe_failed', 'warning', 'database.probe', true, false)];
    }
  }

  async function reportControlPlaneFailure() {
    if (controlPlaneFailure) return;
    controlPlaneFailure = { code: 'health_control_plane_unavailable', at: new Date(now()).toISOString() };
    await notifier.sendIncident({
      componentKey: CONTROL_PLANE.key, severity: 'critical', path: 'controlPlane',
      ...controlPlaneFailure, openedAt: controlPlaneFailure.at,
      details: { componentLabel: CONTROL_PLANE.label, observedValue: 'consulte os logs' },
    }).catch(() => {});
  }

  async function reportControlPlaneRecovery() {
    if (!controlPlaneFailure) return;
    const recovered = controlPlaneFailure;
    controlPlaneFailure = null;
    await notifier.sendRecovery({
      componentKey: CONTROL_PLANE.key, code: recovered.code,
      resolvedAt: new Date(now()).toISOString(),
      details: { componentLabel: CONTROL_PLANE.label },
    }).catch(() => {});
  }

  async function runOnce() {
    status.lastStartedAt = new Date(now()).toISOString();
    let persistenceReady = false;
    try {
      const queryStartedAt = monotonicNow();
      const leaseRows = await leases.list();
      const databaseLatencyMs = Math.max(0, monotonicNow() - queryStartedAt);
      const byKey = new Map(leaseRows.map((lease) => [lease.key, lease]));
      const expected = expectedKeys();
      const runtimeOwners = new Set();
      const issues = definitions.flatMap((definition) => {
        const lease = byKey.get(definition.key);
        const runtimeOwner = lease?.ownerId || `${lease?.ownerHostname}:${lease?.ownerPid}`;
        const evaluateRuntime = Boolean(lease && !runtimeOwners.has(runtimeOwner));
        if (evaluateRuntime) runtimeOwners.add(runtimeOwner);
        return evaluate(definition, lease, {
          expected: expected.has(definition.key), nowMs: now(),
          evaluateRuntime, runtimeThresholds,
        });
      });
      issues.push(...databaseIssues(databaseLatencyMs));
      issues.push(...await probeDatabase());
      await incidents.reconcile({
        issues, evaluatedComponents: [
          ...definitions.map(({ key }) => key), CONTROL_PLANE.key,
        ],
        minimumObservations, observedAt: new Date(now()),
      });
      const claims = await incidents.claimNotifications({ owner, cooldownMs });
      persistenceReady = true;
      await reportControlPlaneRecovery();
      const deliveries = await Promise.allSettled(claims.map(deliver));
      const failed = deliveries.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      status.cycles += 1;
      status.lastIssueCount = issues.length;
      status.lastClaimCount = claims.length;
      status.lastError = null;
    } catch (error) {
      status.lastError = String(error?.message || error).slice(0, 500);
      console.error('[WorkerHealthMonitor] Cycle failed:', status.lastError);
      if (!persistenceReady) await reportControlPlaneFailure();
    } finally {
      status.lastCompletedAt = new Date(now()).toISOString();
    }
  }

  function queueNext() {
    if (!running) return;
    timer = schedule(() => {
      timer = null;
      work = runOnce().finally(queueNext);
    }, intervalMs);
    timer.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      status.running = true;
      work = runOnce().finally(queueNext);
    },
    async stop() {
      running = false;
      status.running = false;
      if (timer) cancelSchedule(timer);
      timer = null;
      await work;
    },
    flush: async () => { await work; },
    getStatus: () => ({ ...status }),
    __private: { runOnce },
  };
}

module.exports = { createWorkerHealthMonitor };
