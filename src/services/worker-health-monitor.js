'use strict';

const { randomUUID } = require('node:crypto');
const os = require('node:os');
const workerLease = require('../models/worker-lease');
const incidentStore = require('../models/worker-health-incident');
const { evaluateWorkerHealth } = require('./worker-health-evaluator');
const { listWorkerHealthDefinitions } = require('./worker-health-registry');
const { createWorkerHealthTelegramNotifier } = require('./worker-health-telegram-notifier');

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createWorkerHealthMonitor(options = {}, deps = {}) {
  const definitions = deps.definitions || listWorkerHealthDefinitions();
  const leases = deps.leaseStore || workerLease;
  const incidents = deps.incidentStore || incidentStore;
  const evaluate = deps.evaluate || evaluateWorkerHealth;
  const notifier = deps.notifier || createWorkerHealthTelegramNotifier(options.telegram);
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
  const owner = String(options.owner || `worker-health:${os.hostname()}:${process.pid}:${randomUUID()}`);
  let running = false;
  let timer = null;
  let work = Promise.resolve();
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

  async function runOnce() {
    status.lastStartedAt = new Date(now()).toISOString();
    try {
      const leaseRows = await leases.list();
      const byKey = new Map(leaseRows.map((lease) => [lease.key, lease]));
      const expected = expectedKeys();
      const issues = definitions.flatMap((definition) => evaluate(
        definition, byKey.get(definition.key), {
          expected: expected.has(definition.key), nowMs: now(),
        }
      ));
      await incidents.reconcile({
        issues, evaluatedComponents: definitions.map(({ key }) => key),
        minimumObservations, observedAt: new Date(now()),
      });
      const claims = await incidents.claimNotifications({ owner, cooldownMs });
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
  };
}

module.exports = { createWorkerHealthMonitor };
