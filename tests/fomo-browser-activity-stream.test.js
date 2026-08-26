'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createFomoBrowserActivityStream,
  normalizeCdpEndpoint,
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
