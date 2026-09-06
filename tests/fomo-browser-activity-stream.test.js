'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createFomoBrowserActivityStream,
  normalizeCdpEndpoint,
  resetFomoBrowserPage,
} = require('../src/services/fomo-browser-activity-stream');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeBrowser(pageUrl = 'https://fomo.family/alerts') {
  const session = new EventEmitter();
  const commands = [];
  session.send = async (method) => { commands.push(method); };
  session.detach = async () => {};

  const page = new EventEmitter();
  page.url = () => pageUrl;
  const context = {
    pages: () => [page],
    newCDPSession: async () => session,
  };
  page.context = () => context;

  const browser = new EventEmitter();
  browser.contexts = () => [context];
  return { browser, commands, page, session };
}

test('Fomo browser stream accepts only loopback CDP endpoints', () => {
  assert.equal(normalizeCdpEndpoint(), 'http://127.0.0.1:9222');
  assert.equal(normalizeCdpEndpoint('http://localhost:9333/'), 'http://localhost:9333');
  assert.throws(() => normalizeCdpEndpoint('http://10.0.0.2:9222'), /localhost/);
  assert.throws(() => normalizeCdpEndpoint('ws://127.0.0.1:9222'), /HTTP/);
  assert.throws(() => normalizeCdpEndpoint('http://user:pass@127.0.0.1:9222'), /credentials/);
});

test('Fomo browser stream captures thesis frames without closing the external Chrome', async () => {
  const fixture = fakeBrowser();
  const evidence = [];
  const frames = [];
  const states = [];
  let browserCloseCalls = 0;
  fixture.browser.close = async () => { browserCloseCalls += 1; };
  const stream = createFomoBrowserActivityStream({
    connectOverCDP: async () => fixture.browser,
    onEvidence: (item) => evidence.push(item),
    onFrame: (item) => frames.push(item),
    onStatus: ({ state }) => states.push(state),
  });

  stream.start();
  await nextTurn();
  assert.deepEqual(fixture.commands, ['Network.enable']);
  assert.deepEqual(states, ['connecting', 'connected']);

  fixture.session.emit('Network.webSocketFrameReceived', {
    response: {
      opcode: 1,
      payloadData: JSON.stringify({
        type: 'data', topicType: 'trading_activity', payload: {
          type: 'thesis', id: 'event-1', userId: 'profile-1', userHandle: 'caller',
          tokenAddress: 'So11111111111111111111111111111111111111112',
          createdAt: '2026-08-26T05:00:00.000Z', comment: { comment: 'Thesis text' },
        },
      }),
    },
  });
  fixture.session.emit('Network.webSocketFrameReceived', {
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'heartbeat' }) },
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].callout.platformEventId, 'event-1');
  assert.equal(stream.getStatus().frames, 2);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].at, stream.getStatus().lastFrameAt);
  assert.equal(stream.getStatus().callouts, 1);
  await stream.stop();
  assert.equal(browserCloseCalls, 0);
});

test('Fomo browser stream reports a missing app tab without leaking the page URL', async () => {
  const fixture = fakeBrowser('https://example.com');
  const errors = [];
  const schedules = [];
  const stream = createFomoBrowserActivityStream({
    connectOverCDP: async () => fixture.browser,
    schedule: (callback, delayMs) => { schedules.push({ callback, delayMs }); return 1; },
    cancelSchedule: () => {},
    random: () => 0.5,
    onError: (error) => errors.push(error),
  });

  stream.start();
  await nextTurn();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'FOMO_BROWSER_PAGE_MISSING');
  assert.equal(errors[0].message, 'Fomo browser transport failed');
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].delayMs, 1000);
  await stream.stop();
});

test('Fomo browser stream replaces a crashed target through loopback CDP', async () => {
  const calls = [];
  const responses = [
    { ok: true, json: async () => [{
      id: 'target-1', type: 'page', url: 'https://fomo.family/alerts',
    }] },
    { ok: true },
    { ok: true },
  ];
  await resetFomoBrowserPage('http://127.0.0.1:9222', {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', signal: init.signal });
      return responses.shift();
    },
  });

  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [{
    url: 'http://127.0.0.1:9222/json/list', method: 'GET',
  }, {
    url: 'http://127.0.0.1:9222/json/close/target-1', method: 'GET',
  }, {
    url: 'http://127.0.0.1:9222/json/new?https%3A%2F%2Ffomo.family%2Falerts', method: 'PUT',
  }]);
  assert.equal(calls.every(({ signal }) => signal instanceof AbortSignal), true);
});

test('Fomo browser stream resets the page after repeated CDP connection failures', async () => {
  const timers = new Map();
  const states = [];
  let timerId = 0;
  let resets = 0;
  const stream = createFomoBrowserActivityStream({
    connectOverCDP: async () => { throw new Error('CDP target crashed'); },
    resetBrowserPage: async () => { resets += 1; },
    random: () => 0.5,
    schedule: (callback, delayMs) => {
      timerId += 1;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    cancelSchedule: (id) => timers.delete(id),
    onStatus: ({ state }) => states.push(state),
  });

  stream.start();
  await nextTurn();
  assert.equal(resets, 0);
  const retry = [...timers.entries()][0];
  timers.delete(retry[0]);
  retry[1].callback();
  await nextTurn();
  assert.equal(resets, 1);
  assert.equal(stream.getStatus().pageResets, 1);
  assert.equal(states.includes('page_reset'), true);
  await stream.stop();
});

test('Fomo browser stream reloads immediately when the attached page crashes', async () => {
  const fixture = fakeBrowser();
  const states = [];
  let reloads = 0;
  fixture.page.reload = async () => { reloads += 1; };
  const stream = createFomoBrowserActivityStream({
    connectOverCDP: async () => fixture.browser,
    onStatus: ({ state }) => states.push(state),
  });

  stream.start();
  await nextTurn();
  fixture.page.emit('crash');
  await nextTurn();
  assert.equal(reloads, 1);
  assert.equal(stream.getStatus().crashReloads, 1);
  assert.equal(states.includes('crash_reloading'), true);
  await stream.stop();
});

test('Fomo browser stream reloads a stale page once and enforces its cooldown', async () => {
  const fixture = fakeBrowser();
  const timers = new Map();
  const states = [];
  let timerId = 0;
  let currentMs = Date.parse('2026-08-29T06:00:00.000Z');
  let reloads = 0;
  fixture.page.reload = async (options) => {
    reloads += 1;
    assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  };
  const stream = createFomoBrowserActivityStream({
    connectOverCDP: async () => fixture.browser,
    now: () => currentMs,
    schedule: (callback, delayMs) => {
      timerId += 1;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    cancelSchedule: (id) => timers.delete(id),
    onStatus: ({ state }) => states.push(state),
  });

  stream.start();
  await nextTurn();
  const stale = [...timers.entries()][0];
  assert.equal(stale[1].delayMs, 90_000);
  timers.delete(stale[0]);
  stale[1].callback();
  await nextTurn();
  assert.equal(reloads, 1);
  assert.equal(stream.getStatus().staleReloads, 1);
  assert.equal(stream.getStatus().lastStaleReloadAt, '2026-08-29T06:00:00.000Z');
  assert.equal(states.includes('stale_reloading'), true);

  const duringCooldown = [...timers.entries()][0];
  timers.delete(duringCooldown[0]);
  duringCooldown[1].callback();
  await nextTurn();
  assert.equal(reloads, 1);
  assert.equal([...timers.values()][0].delayMs, 300_000);

  currentMs += 300_000;
  await stream.stop();
  assert.equal(timers.size, 0);
});

test('Fomo browser stream reconnects when automatic stale reload fails', async () => {
  const fixture = fakeBrowser();
  const timers = new Map();
  const errors = [];
  let timerId = 0;
  fixture.page.reload = async () => { throw new Error('renderer crashed'); };
  const stream = createFomoBrowserActivityStream({
    connectOverCDP: async () => fixture.browser,
    random: () => 0.5,
    schedule: (callback, delayMs) => {
      timerId += 1;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    cancelSchedule: (id) => timers.delete(id),
    onError: (error) => errors.push(error),
  });

  stream.start();
  await nextTurn();
  const stale = [...timers.entries()][0];
  timers.delete(stale[0]);
  stale[1].callback();
  await nextTurn();
  assert.equal(errors[0].code, 'FOMO_BROWSER_STALE_RELOAD');
  assert.equal(stream.getStatus().staleReloadErrors, 1);
  assert.equal(stream.getStatus().connected, false);
  assert.equal([...timers.values()][0].delayMs, 1_000);
  await stream.stop();
});
