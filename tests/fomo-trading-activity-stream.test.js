'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFomoFrame } = require('../src/services/fomo-frame-normalizer');
const {
  createFomoTradingActivityStream,
  createTradingActivitySubscribePayload,
} = require('../src/services/fomo-trading-activity-stream');

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

test('measured Fomo thesis frame normalizes into a callout', () => {
  const evidence = normalizeFomoFrame(JSON.stringify({
    type: 'data',
    topicType: 'trading_activity',
    topicId: 'viewer-id',
    payload: {
      type: 'thesis',
      id: 'callout-1',
      tradeId: 'trade-1',
      createdAt: '2026-08-25T01:04:23.221Z',
      userId: 'profile-1',
      displayName: 'Trader',
      userHandle: 'trader',
      comment: { comment: 'measured thesis', numLikes: 2 },
      tokenAddress: 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump',
      networkId: 1399811149,
      ticker: 'CATE',
      threshold: 359277.28,
      equity: 360712.64,
      isDev: false,
    },
  }));

  assert.equal(evidence.tradingActivityCandidate, true);
  assert.equal(evidence.topic, 'trading_activity');
  assert.deepEqual(evidence.callout, {
    platform: 'fomo',
    eventType: 'callout',
    sourceType: 'thesis',
    platformEventId: 'callout-1',
    tradeId: 'trade-1',
    occurredAt: '2026-08-25T01:04:23.221Z',
    profile: {
      platformUserId: 'profile-1',
      handle: 'trader',
      displayName: 'Trader',
      profilePictureUrl: null,
    },
    asset: {
      address: 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump',
      rawNetworkId: 1399811149,
      ticker: 'CATE',
      imageUrl: null,
    },
    thesis: { text: 'measured thesis', numReplies: null, numLikes: 2 },
    platformMetrics: { threshold: 359277.28, equity: 360712.64, isDev: false },
  });
});

test('trading activity subscribe payload matches the measured contract', () => {
  const topicId = 'ea1bc7f5-e349-5c6d-ab41-740c237a792d';
  assert.deepEqual(createTradingActivitySubscribePayload(topicId), {
    type: 'subscribe',
    topicType: 'trading_activity',
    topicId,
  });
  assert.throws(() => createTradingActivitySubscribePayload('not-a-uuid'), /must be a UUID/);
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

test('stream authenticates a challenge before subscribing without exposing JWT evidence', () => {
  const socket = new FakeWebSocket();
  const frames = [];
  const states = [];
  const jwt = 'eyJ0ZXN0.secret.signature';
  const stream = createFomoTradingActivityStream({
    wsUrl: 'wss://example.test/ws',
    authenticationJwt: jwt,
    subscribePayload: { type: 'subscribe', topic: 'measured-contract' },
    wsFactory: () => socket,
    onEvidence: (frame) => frames.push(frame),
    onStatus: (status) => states.push(status),
  });

  stream.start();
  socket.open();
  assert.deepEqual(socket.sent, []);

  socket.receive(JSON.stringify({ type: 'challenge' }));
  assert.deepEqual(socket.sent, [JSON.stringify({ type: 'challengeResponse', jwt })]);

  socket.receive(JSON.stringify({ type: 'challengeAccepted' }));
  assert.deepEqual(socket.sent, [
    JSON.stringify({ type: 'challengeResponse', jwt }),
    '{"type":"subscribe","topic":"measured-contract"}',
  ]);
  assert.equal(stream.getStatus().authenticated, true);
  assert.equal(stream.getStatus().authResponses, 1);
  assert.equal(stream.getStatus().authAcceptances, 1);
  assert.equal(JSON.stringify({ frames, states }).includes(jwt), false);
  stream.stop();
});

test('stream rejects an incomplete authentication JWT before connecting', () => {
  assert.throws(() => createFomoTradingActivityStream({
    wsUrl: 'wss://example.test/ws',
    authenticationJwt: 'eyJ0ZXN0',
  }), /three base64url segments/);
});

test('stream rejects an expired authentication JWT before reconnecting', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
  assert.throws(() => createFomoTradingActivityStream({
    wsUrl: 'wss://example.test/ws',
    authenticationJwt: `header.${payload}.signature`,
  }), /has expired/);
});

test('credential provider is reread and authentication failures keep reconnect backoff', async () => {
  const sockets = [];
  const scheduled = [];
  let attempts = 0;
  const validJwt = 'header.payload.signature';
  const stream = createFomoTradingActivityStream({
    wsUrl: 'wss://example.test/ws',
    authenticationJwtProvider: () => {
      attempts += 1;
      if (attempts < 3) throw new Error('credential unavailable');
      return validJwt;
    },
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
  for (let index = 0; index < 2; index += 1) {
    sockets[index].open();
    sockets[index].receive(JSON.stringify({ type: 'challenge' }));
    await new Promise((resolve) => setImmediate(resolve));
    scheduled[index].callback();
  }
  sockets[2].open();
  sockets[2].receive(JSON.stringify({ type: 'challenge' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [1000, 2000]);
  assert.deepEqual(sockets[2].sent, [JSON.stringify({ type: 'challengeResponse', jwt: validJwt })]);
  assert.equal(stream.getStatus().authFailures, 2);
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
