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
  const monitor = createWorkerHealthMonitor({
    expectedComponents: [], minimumObservations: 1,
    expectedComponentsProvider: () => ['test-worker'],
  }, {
    definitions: [definition], leaseStore: { list: async () => [] }, incidentStore,
    notifier: {
      sendIncident: overrides.sendIncident || (async (input) => notified.push(input)),
      sendRecovery: async () => {},
    },
    schedule: () => ({ unref() {} }), cancelSchedule: () => {},
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
  });
  return { monitor, reconciliations, marked, released, notified };
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
    assert.deepEqual(harness.reconciliations[0].evaluatedComponents, ['test-worker']);
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
    details: { componentLabel: 'Catalog worker', observedValue: false },
  };
  await notifier.sendIncident(incident);
  await notifier.sendRecovery(incident);
  await notifier.sendIncident({
    ...incident, code: 'active_error',
    details: { ...incident.details, observedValue: 'https://service.invalid/?token=secret' },
  });

  assert.equal(messages[0].chat_id, '123456');
  assert.match(messages[0].text, /Catalog worker/);
  assert.match(messages[0].text, /Se foi você, tudo bem/);
  assert.match(messages[1].text, /worker recuperado/);
  assert.doesNotMatch(messages[2].text, /secret/);
});
