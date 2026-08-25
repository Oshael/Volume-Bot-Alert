'use strict';

const WebSocket = require('ws');
const { normalizeFomoFrame } = require('./fomo-frame-normalizer');

const DEFAULT_WS_URL = 'wss://prod-api.fomo.family/ws';
const DEFAULT_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

function positiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function normalizeWsUrl(value) {
  const url = new URL(String(value || DEFAULT_WS_URL).trim());
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new TypeError('Fomo endpoint must use WS(S)');
  if (url.username || url.password) throw new TypeError('Fomo endpoint must not contain credentials');
  url.hash = '';
  return url.toString();
}

function safeError(error, fallbackCode = 'FOMO_WS_ERROR') {
  const safe = new Error('Fomo WebSocket transport failed');
  safe.code = String(error?.code || fallbackCode);
  safe.statusCode = Number(error?.statusCode) || null;
  return safe;
}

function normalizeAuthenticationJwt(value) {
  const jwt = String(value || '').trim();
  if (!jwt) return '';
  const segments = jwt.split('.');
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new TypeError('Fomo authentication JWT must contain three base64url segments');
  }
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (Number.isFinite(payload.exp) && payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new TypeError('Fomo authentication JWT has expired');
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
  }
  return jwt;
}

function createTradingActivitySubscribePayload(value) {
  const topicId = String(value || '').trim();
  if (!topicId) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicId)) {
    throw new TypeError('Fomo trading activity topic ID must be a UUID');
  }
  return { type: 'subscribe', topicType: 'trading_activity', topicId };
}

function createFomoTradingActivityStream(options = {}) {
  const wsUrl = normalizeWsUrl(options.wsUrl);
  const headers = { ...(options.headers || {}) };
  const authenticationJwt = normalizeAuthenticationJwt(options.authenticationJwt);
  const authenticationJwtProvider = options.authenticationJwtProvider;
  if (authenticationJwtProvider !== undefined && typeof authenticationJwtProvider !== 'function') {
    throw new TypeError('Fomo authentication JWT provider must be a function');
  }
  const usesAuthentication = Boolean(authenticationJwt || authenticationJwtProvider);
  const subscribePayload = options.subscribePayload;
  const wsFactory = options.wsFactory || ((url, clientOptions) => new WebSocket(url, clientOptions));
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const random = options.random || Math.random;
  const onEvidence = options.onEvidence || (() => {});
  const onStatus = options.onStatus || (() => {});
  const onError = options.onError || (() => {});
  const baseReconnectMs = positiveInteger(options.reconnectMs, DEFAULT_RECONNECT_MS, MAX_RECONNECT_MS);
  const maxPayload = positiveInteger(options.maxPayloadBytes, 256 * 1024, 10 * 1024 * 1024);

  let socket = null;
  let running = false;
  let reconnectTimer = null;
  let reconnectMs = baseReconnectMs;
  let subscribeSent = false;
  const status = {
    connected: false,
    authenticated: false,
    connects: 0,
    reconnects: 0,
    frames: 0,
    bytes: 0,
    jsonFrames: 0,
    candidates: 0,
    opaqueFrames: 0,
    challenges: 0,
    authResponses: 0,
    authAcceptances: 0,
    authFailures: 0,
    callouts: 0,
  };

  function emitStatus(state, extra = {}) {
    onStatus({ state, ...extra, metrics: { ...status } });
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    const jitteredMs = Math.round(reconnectMs * (0.8 + (random() * 0.4)));
    status.reconnects += 1;
    emitStatus('reconnecting', { delayMs: jitteredMs });
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, jitteredMs);
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
  }

  function sendSubscribe() {
    if (subscribeSent || subscribePayload === undefined || subscribePayload === null) return;
    try {
      socket.send(typeof subscribePayload === 'string' ? subscribePayload : JSON.stringify(subscribePayload));
      subscribeSent = true;
      emitStatus('subscribe_sent');
    } catch (error) {
      onError(safeError(error, 'FOMO_WS_SUBSCRIBE'));
      socket.close();
    }
  }

  function failCredential(error, challengedSocket) {
    status.authFailures += 1;
    onError(safeError(error, 'FOMO_WS_CREDENTIAL'));
    challengedSocket.close(4001);
  }

  function sendChallengeResponse(value, challengedSocket) {
    try {
      const jwt = normalizeAuthenticationJwt(value);
      if (!jwt) throw new TypeError('Fomo authentication JWT is required');
      if (!running || challengedSocket !== socket) return;
      challengedSocket.send(JSON.stringify({ type: 'challengeResponse', jwt }));
      status.authResponses += 1;
      emitStatus('challenge_response_sent');
    } catch (error) {
      failCredential(error, challengedSocket);
    }
  }

  function handleControlFrame(evidence) {
    if (evidence.frameKind !== 'json') return;
    if (evidence.eventType === 'challenge') {
      status.challenges += 1;
      emitStatus('challenge_received');
      const challengedSocket = socket;
      if (authenticationJwtProvider) {
        Promise.resolve().then(authenticationJwtProvider)
          .then((jwt) => sendChallengeResponse(jwt, challengedSocket))
          .catch((error) => failCredential(error, challengedSocket));
      } else if (authenticationJwt) sendChallengeResponse(authenticationJwt, challengedSocket);
      return;
    }
    if (evidence.eventType === 'challengeAccepted') {
      status.authAcceptances += 1;
      status.authenticated = true;
      reconnectMs = baseReconnectMs;
      emitStatus('challenge_accepted');
      sendSubscribe();
    }
  }

  function handleFrame(raw, binary) {
    const evidence = normalizeFomoFrame(raw, { binary });
    status.frames += 1;
    status.bytes += evidence.byteLength;
    if (evidence.frameKind === 'json') status.jsonFrames += 1;
    if (evidence.frameKind === 'opaque' || evidence.frameKind === 'binary') status.opaqueFrames += 1;
    if (evidence.tradingActivityCandidate) status.candidates += 1;
    if (evidence.callout) status.callouts += 1;
    handleControlFrame(evidence);
    onEvidence(evidence);
  }

  function connect() {
    if (!running) return;
    try {
      socket = wsFactory(wsUrl, { headers, maxPayload });
    } catch (error) {
      onError(safeError(error, 'FOMO_WS_CREATE'));
      scheduleReconnect();
      return;
    }
    status.connects += 1;
    emitStatus('connecting');
    socket.on('open', () => {
      status.connected = true;
      status.authenticated = false;
      subscribeSent = false;
      emitStatus('connected');
      if (!usesAuthentication) {
        reconnectMs = baseReconnectMs;
        sendSubscribe();
      }
    });
    socket.on('message', handleFrame);
    socket.on('error', (error) => onError(safeError(error)));
    socket.on('close', (code) => {
      status.connected = false;
      status.authenticated = false;
      emitStatus('closed', { code: Number(code) || null });
      scheduleReconnect();
    });
  }

  function start() {
    if (running) return;
    running = true;
    connect();
  }

  function stop() {
    running = false;
    status.connected = false;
    status.authenticated = false;
    if (reconnectTimer) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    try { socket?.close(); } catch (error) { onError(safeError(error)); }
  }

  return { start, stop, getStatus: () => ({ running, ...status }) };
}

module.exports = {
  createFomoTradingActivityStream,
  createTradingActivitySubscribePayload,
  normalizeAuthenticationJwt,
  normalizeWsUrl,
};
