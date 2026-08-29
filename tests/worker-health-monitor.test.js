'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWorkerHealthMonitor } = require('../src/services/worker-health-monitor');
const {
  createWorkerHealthTelegramNotifier,
} = require('../src/services/worker-health-telegram-notifier');

const definition = {
  key: 'test-worker', label: 'Test worker', group: 'test', groups: ['test'],
  thresholds: {
    startupGraceMs: 1_000, freshnessMs: 1_000, maxInFlightMs: 1_000,
    maxConsecutiveErrors: 2, maxLagBlocks: 2, maxLagMs: 1_000,
    maxLoopOverrunMs: 1_000, maxQueue: 10,
  },
};

function monitorHarness(overrides = {}) {
  const reconciliations = [];
  const marked = [];
  const released = [];
  const claim = {
    incidentKey: 'test-worker:lease:lease_missing', notificationKind: 'incident',
    componentKey: 'test-worker', code: 'lease_missing', severity: 'critical',
    path: 'lease', details: { componentLabel: 'Test worker' },
  };
  const incidentStore = {
    reconcile: async (input) => reconciliations.push(input),
    claimNotifications: async () => [claim],
    markNotificationSent: async (input) => marked.push(input),
    releaseNotificationClaim: async (input) => released.push(input),
  };
  const notified = [];
  const recoveries = [];
  const monitor = createWorkerHealthMonitor({
    expectedComponents: [], minimumObservations: 1,
    expectedComponentsProvider: () => ['test-worker'],
  }, {
    definitions: [definition], leaseStore: overrides.leaseStore || { list: async () => [] },
    incidentStore: { ...incidentStore, ...overrides.incidentStore },
    database: overrides.database || {
      pool: { waitingCount: 0, totalCount: 0, idleCount: 0 },
      query: async () => ({ rows: [{ wal_bytes: '0', oldest_idle_ms: 0, blocked_queries: 0 }] }),
    },
    notifier: {
      sendIncident: overrides.sendIncident || (async (input) => notified.push(input)),
      sendRecovery: async (input) => recoveries.push(input),
    },
    schedule: () => ({ unref() {} }), cancelSchedule: () => {},
    now: overrides.now || (() => Date.parse('2026-08-29T12:00:00.000Z')),
    monotonicNow: overrides.monotonicNow,
  });
  return { monitor, reconciliations, marked, released, notified, recoveries };
}

describe('worker health monitor', () => {
  it('rejects unknown configured worker keys', () => {
    assert.throws(() => createWorkerHealthMonitor({
      expectedComponents: ['typo-worker'], telegram: {},
    }, { definitions: [definition], notifier: {} }), /Unknown expected worker/);
  });

  it('evaluates an expected missing worker and settles its durable notification', async () => {
    const harness = monitorHarness();
    harness.monitor.start();
    await harness.monitor.flush();

    assert.equal(harness.reconciliations[0].issues[0].code, 'lease_missing');
    assert.deepEqual(harness.reconciliations[0].evaluatedComponents,
      ['test-worker', 'worker-health-monitor']);
    assert.equal(harness.notified.length, 1);
    assert.equal(harness.marked[0].kind, 'incident');
    assert.equal(harness.monitor.getStatus().lastError, null);
    await harness.monitor.stop();
  });

  it('releases a failed Telegram claim for persistent retry', async () => {
    const harness = monitorHarness({ sendIncident: async () => { throw new Error('offline'); } });
    harness.monitor.start();
    await harness.monitor.flush();

    assert.equal(harness.released[0].kind, 'incident');
    assert.equal(harness.monitor.getStatus().lastError, 'offline');
    await harness.monitor.stop();
  });

  it('persists database latency and pool pressure as health incidents', async () => {
    const ticks = [0, 2_500];
    const harness = monitorHarness({
      monotonicNow: () => ticks.shift(),
      database: {
        pool: { waitingCount: 3, totalCount: 10, idleCount: 0, options: { max: 10 } },
        query: async () => ({ rows: [{ wal_bytes: '0', oldest_idle_ms: 0, blocked_queries: 0 }] }),
      },
    });
    harness.monitor.start();
    await harness.monitor.flush();
    const codes = harness.reconciliations[0].issues.map(({ code }) => code);
    assert.ok(codes.includes('database_latency_high'));
    assert.ok(codes.includes('database_pool_pressure'));
    await harness.monitor.stop();
  });

  it('detects blocked work, long transactions and abnormal WAL growth', async () => {
    let nowMs = Date.parse('2026-08-29T12:00:00.000Z');
    let walBytes = 1_000;
    const harness = monitorHarness({
      now: () => nowMs,
      database: {
        pool: { waitingCount: 0, totalCount: 1, idleCount: 1 },
        query: async () => ({ rows: [{
          wal_bytes: String(walBytes), oldest_idle_ms: 400_000, blocked_queries: 2,
        }] }),
      },
    });
    harness.monitor.start();
    await harness.monitor.flush();
    nowMs += 60_000;
    walBytes += 2 * 1024 ** 3;
    await harness.monitor.__private.runOnce();
    const codes = harness.reconciliations[1].issues.map(({ code }) => code);
    assert.ok(codes.includes('database_long_transaction'));
    assert.ok(codes.includes('database_blocked_queries'));
    assert.ok(codes.includes('wal_growth_high'));
    await harness.monitor.stop();
  });

  it('uses direct Telegram fallback while persistence is unavailable and reports recovery', async () => {
    let offline = true;
    const harness = monitorHarness({
      leaseStore: { list: async () => { if (offline) throw new Error('database offline'); return []; } },
    });
    harness.monitor.start();
    await harness.monitor.flush();
    assert.equal(harness.notified[0].code, 'health_control_plane_unavailable');

    offline = false;
    await harness.monitor.__private.runOnce();
    assert.equal(harness.recoveries[0].code, 'health_control_plane_unavailable');
    await harness.monitor.stop();
  });

  it('evaluates shared process pressure only once per lease owner', async () => {
    const runtimeFlags = [];
    const monitor = createWorkerHealthMonitor({}, {
      definitions: [definition, { ...definition, key: 'test-worker-2' }],
      leaseStore: { list: async () => [
        { key: 'test-worker', ownerId: 'shared-owner', metadata: {} },
        { key: 'test-worker-2', ownerId: 'shared-owner', metadata: {} },
      ] },
      evaluate: (_definition, _lease, options) => { runtimeFlags.push(options.evaluateRuntime); return []; },
      incidentStore: {
        reconcile: async () => {}, claimNotifications: async () => [],
      },
      database: {
        pool: {},
        query: async () => ({ rows: [{ wal_bytes: '0', oldest_idle_ms: 0, blocked_queries: 0 }] }),
      },
      notifier: { sendIncident: async () => {}, sendRecovery: async () => {} },
      schedule: () => ({ unref() {} }), cancelSchedule: () => {},
    });
    monitor.start();
    await monitor.flush();
    assert.deepEqual(runtimeFlags, [true, false]);
    await monitor.stop();
  });
});

it('sends customized worker incident and recovery messages through the ops chat', async () => {
  const messages = [];
  const notifier = createWorkerHealthTelegramNotifier({
    chatId: '123456', botClient: { sendMessage: async (message) => messages.push(message) },
  });
  const incident = {
    componentKey: 'catalog-worker', code: 'component_stopped', severity: 'critical',
    path: 'telemetry', openedAt: '2026-08-29T12:00:00.000Z',
    resolvedAt: '2026-08-29T12:02:00.000Z',
    details: {
      componentLabel: 'Catalog worker', observedValue: false,
      runtimeGroup: 'core', allowedGroups: ['core'],
    },
  };
  await notifier.sendIncident(incident);
  await notifier.sendRecovery(incident);
  await notifier.sendIncident({
    ...incident, code: 'active_error',
    details: {
      ...incident.details,
      observedValue: {
        code: 'http_error',
        message: 'Blockscout address returned HTTP 403',
        apiKey: 'secret',
      },
    },
  });
  await notifier.sendIncident({
    ...incident, code: 'telemetry_error',
    details: { ...incident.details, observedValue: 'https://service.invalid/?token=secret' },
  });

  assert.equal(messages[0].chat_id, '123456');
  assert.match(messages[0].text, /Catalog worker/);
  assert.match(messages[0].text, /Chave: catalog-worker/);
  assert.match(messages[0].text, /Processo: core/);
  assert.match(messages[0].text, /Unit: trendscope-worker@core\.service/);
  assert.match(messages[0].text,
    /journalctl -u trendscope-worker@core\.service -n 100 --no-pager/);
  assert.match(messages[0].text, /Se foi você, tudo bem/);
  assert.match(messages[1].text, /worker recuperado/);
  assert.match(messages[1].text, /Unit: trendscope-worker@core\.service/);
  assert.match(messages[2].text,
    /Valor observado: http_error: Blockscout address returned HTTP 403/);
  assert.doesNotMatch(messages[2].text, /secret/);
  assert.match(messages[3].text, /token=\[redacted\]/);
  assert.doesNotMatch(messages[3].text, /token=secret/);
});
