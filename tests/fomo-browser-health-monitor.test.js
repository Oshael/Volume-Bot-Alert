'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createFomoBrowserHealthMonitor,
} = require('../src/services/fomo-browser-health-monitor');

test('Fomo browser watchdog alerts once on silence and announces recovery', async () => {
  const timers = [];
  const incidents = [];
  const recoveries = [];
  let nowMs = Date.parse('2026-08-26T20:00:00.000Z');
  const monitor = createFomoBrowserHealthMonitor({
    enabled: true,
    staleMs: 90_000,
    now: () => nowMs,
    schedule: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length; },
    cancelSchedule: () => {},
    notifier: {
      sendStreamIncident: async (event) => incidents.push(event),
      sendStreamRecovery: async (event) => recoveries.push(event),
    },
  });

  monitor.start();
  monitor.onStatus({ state: 'connected' });
  assert.equal(timers[0].delayMs, 90_000);
  timers[0].callback();
  monitor.onError({ code: 'SECOND_ERROR_MUST_BE_DEDUPED' });
  assert.equal(monitor.getStatus().healthy, false);

  nowMs += 91_000;
  monitor.onFrame({ at: new Date(nowMs).toISOString() });
  await monitor.flush();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].code, 'FOMO_BROWSER_STREAM_STALE');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].recoveredCode, 'FOMO_BROWSER_STREAM_STALE');
  assert.equal(monitor.getStatus().healthy, true);
  await monitor.stop();
});

test('Fomo browser watchdog isolates Telegram delivery failures', async () => {
  const monitor = createFomoBrowserHealthMonitor({
    enabled: true,
    notifier: {
      sendStreamIncident: async () => {
        throw Object.assign(new Error('telegram down'), { code: 'telegram_timeout' });
      },
      sendStreamRecovery: async () => {},
    },
  });

  monitor.start();
  monitor.onError({ code: 'FOMO_BROWSER_CONNECT' });
  await monitor.flush();
  assert.equal(monitor.getStatus().incidentKind, 'transport');
  assert.equal(monitor.getStatus().notificationErrors, 1);
  assert.equal(monitor.getStatus().lastNotificationErrorCode, 'telegram_timeout');
  await monitor.stop();
});

test('Fomo browser watchdog gives automatic stale reload time to recover before alerting', async () => {
  const timers = new Map();
  const incidents = [];
  let timerId = 0;
  const monitor = createFomoBrowserHealthMonitor({
    enabled: true, staleMs: 90_000, recoveryGraceMs: 30_000,
    schedule: (callback, delayMs) => {
      timerId += 1;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    cancelSchedule: (id) => timers.delete(id),
    notifier: {
      sendStreamIncident: async (event) => incidents.push(event),
      sendStreamRecovery: async () => {},
    },
  });

  monitor.start();
  monitor.onStatus({ state: 'connected' });
  monitor.onStatus({ state: 'stale_reloading' });
  assert.equal([...timers.values()][0].delayMs, 30_000);
  monitor.onFrame({ at: '2026-08-29T06:01:20.000Z' });
  await monitor.flush();
  assert.equal(incidents.length, 0);
  assert.equal([...timers.values()][0].delayMs, 90_000);
  await monitor.stop();
});
