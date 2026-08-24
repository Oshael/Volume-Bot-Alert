'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFomoFrame } = require('../src/services/fomo-frame-normalizer');
const { createFomoTradingActivityStream } = require('../src/services/fomo-trading-activity-stream');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
  }

  open() { this.emit('open'); }
  send(value) { this.sent.push(value); }
  receive(value, binary = false) { this.emit('message', Buffer.from(value), binary); }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
}

test('Fomo JSON evidence is classified and recursively redacted', () => {
  const evidence = normalizeFomoFrame(JSON.stringify({
    topic: 'trading_activity',
    type: 'callout',
    cookie: 'secret',
    data: { csrfToken: 'secret', thesis: 'Bearer abc.def', coin: 'MINT' },
  }));

  assert.equal(evidence.frameKind, 'json');
  assert.equal(evidence.tradingActivityCandidate, true);
  assert.equal(evidence.payload.cookie, undefined);
  assert.equal(evidence.payload.data.csrfToken, undefined);
  assert.equal(evidence.payload.data.thesis, 'Bearer [REDACTED]');
  assert.equal(evidence.payload.data.coin, 'MINT');
});

test('opaque and binary frames retain only size and fingerprint', () => {
  const opaque = normalizeFomoFrame('not-json auth_token=secret');
  const binary = normalizeFomoFrame(Buffer.from('binary-secret'), { binary: true });

  assert.equal(opaque.frameKind, 'opaque');
  assert.equal(opaque.payload, null);
  assert.equal(binary.frameKind, 'binary');
  assert.equal(binary.payload, null);
  assert.match(opaque.fingerprint, /^[a-f0-9]{64}$/);
});

test('Socket.IO-prefixed JSON remains inspectable without exposing secrets', () => {
  const evidence = normalizeFomoFrame('42["trading_activity",{"auth_token":"secret","id":"event-1"}]');

  assert.equal(evidence.frameKind, 'json');
  assert.equal(evidence.protocolPrefix, '42');
  assert.equal(evidence.tradingActivityCandidate, true);
  assert.deepEqual(evidence.payload, ['trading_activity', { id: 'event-1' }]);
});

test('stream sends only the supplied subscribe payload and emits sanitized evidence', () => {
  const socket = new FakeWebSocket();
  const frames = [];
  const states = [];
  const stream = createFomoTradingActivityStream({
    wsUrl: 'wss://example.test/ws',
    headers: { Cookie: 'auth_token=secret' },
    subscribePayload: { exact: 'measured-contract' },
    wsFactory: (_url, options) => {
      assert.equal(options.headers.Cookie, 'auth_token=secret');
      return socket;
    },
    onEvidence: (frame) => frames.push(frame),
    onStatus: (status) => states.push(status),
  });

  stream.start();
  socket.open();
  socket.receive(JSON.stringify({ channel: 'trading_activity', authToken: 'secret' }));

  assert.deepEqual(socket.sent, ['{"exact":"measured-contract"}']);
  assert.equal(frames[0].payload.authToken, undefined);
  assert.equal(stream.getStatus().candidates, 1);
  assert.equal(JSON.stringify(states).includes('auth_token=secret'), false);
  stream.stop();
});

test('unexpected closes reconnect with bounded exponential backoff', () => {
  const sockets = [];
  const scheduled = [];
  const stream = createFomoTradingActivityStream({
    wsUrl: 'wss://example.test/ws',
    reconnectMs: 1000,
    random: () => 0.5,
    wsFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancelSchedule: () => {},
  });

  stream.start();
  sockets[0].close(1006);
  assert.equal(scheduled[0].delayMs, 1000);
  scheduled[0].callback();
  sockets[1].close(1006);
  assert.equal(scheduled[1].delayMs, 2000);
  stream.stop();
});
