'use strict';

const { chromium } = require('playwright-core');
const { detachCdpSession } = require('./fomo-cdp-session');
const { normalizeFomoFrame } = require('./fomo-frame-normalizer');

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const DEFAULT_PAGE_RESET_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RELOAD_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_RESET_TIMEOUT_MS = 10_000;
const CONNECT_FAILURES_BEFORE_PAGE_RESET = 2;
const DEFAULT_FOMO_PAGE_URL = 'https://fomo.family/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571';
const FRAME_TELEMETRY_LABELS = new Set([
  'unknown', 'data', 'heartbeat', 'ping', 'pong', 'message', 'error',
  'challenge', 'challengeaccepted', 'subscribe', 'trading_activity',
  'thesis', 'callout', 'trade', 'buy', 'sell', 'comment',
  'missing_event_id', 'missing_user_id', 'missing_token_address',
  'missing_thesis_text', 'unsupported_shape',
]);

function positiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function normalizeCdpEndpoint(value) {
  const endpoint = new URL(String(value || DEFAULT_CDP_ENDPOINT).trim());
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !localHosts.has(endpoint.hostname)) {
    throw new TypeError('Fomo browser CDP endpoint must use HTTP(S) on localhost');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Fomo browser CDP endpoint must not contain credentials, query, or fragment');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function isFomoUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'fomo.family' || hostname === 'www.fomo.family';
  } catch {
    return false;
  }
}

function isFomoPage(page) {
  return isFomoUrl(page.url());
}

function isFomoWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:'
      && (url.hostname === 'fomo.family' || url.hostname.endsWith('.fomo.family'));
  } catch {
    return false;
  }
}

function telemetryLabel(value) {
  const label = String(value || 'unknown').trim().toLowerCase();
  return FRAME_TELEMETRY_LABELS.has(label) ? label : 'other';
}

function incrementLabelCounter(target, value) {
  const key = telemetryLabel(value);
  target[key] = (target[key] || 0) + 1;
}

async function resetFomoBrowserPage(endpoint, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required for page recovery');
  const timeoutMs = positiveInteger(
    options.timeoutMs, DEFAULT_PAGE_RESET_TIMEOUT_MS, 60_000,
  );
  const request = (url, init) => fetchImpl(url, {
    ...init, signal: AbortSignal.timeout(timeoutMs),
  });
  const listResponse = await request(`${endpoint}/json/list`);
  if (!listResponse.ok) throw new Error('Could not inspect Chrome targets');
  const targets = await listResponse.json();
  const target = Array.isArray(targets)
    ? targets.find((item) => item?.type === 'page' && isFomoUrl(item.url)) : null;
  const pageUrl = target?.url || DEFAULT_FOMO_PAGE_URL;
  const openResponse = await request(
    `${endpoint}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' },
  );
  if (!openResponse.ok) throw new Error('Could not open replacement Fomo target');
  if (target?.id) {
    const closeResponse = await request(`${endpoint}/json/close/${encodeURIComponent(target.id)}`);
    if (!closeResponse.ok) throw new Error('Could not close crashed Fomo target');
  }
}

function safeError(error, fallbackCode = 'FOMO_BROWSER_CDP') {
  const safe = new Error('Fomo browser transport failed');
  safe.code = String(error?.code || fallbackCode);
  return safe;
}

function createFomoBrowserActivityStream(options = {}) {
  const endpoint = normalizeCdpEndpoint(options.cdpEndpoint);
  const connectOverCDP = options.connectOverCDP || ((url) => chromium.connectOverCDP(url));
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const random = options.random || Math.random;
  const onEvidence = options.onEvidence || (() => {});
  const onFrame = options.onFrame || (() => {});
  const onStatus = options.onStatus || (() => {});
  const onError = options.onError || (() => {});
  const resetBrowserPage = options.resetBrowserPage || resetFomoBrowserPage;
  const detachSession = options.detachCdpSession || detachCdpSession;
  const baseReconnectMs = positiveInteger(options.reconnectMs, DEFAULT_RECONNECT_MS, MAX_RECONNECT_MS);
  const pageResetCooldownMs = positiveInteger(
    options.pageResetCooldownMs, DEFAULT_PAGE_RESET_COOLDOWN_MS, 60 * 60_000,
  );
  const reloadTimeoutMs = positiveInteger(
    options.reloadTimeoutMs, DEFAULT_RELOAD_TIMEOUT_MS, 60_000,
  );
  const now = options.now || Date.now;

  let running = false;
  let connecting = false;
  let browser = null;
  let page = null;
  let session = null;
  let reconnectTimer = null;
  let pageReloadRunning = false;
  let consecutiveConnectFailures = 0;
  let lastPageResetMs = null;
  let reconnectMs = baseReconnectMs;
  const fomoWebSockets = new Set();
  const frameFingerprints = new Set();
  const status = {
    connected: false,
    connects: 0,
    reconnects: 0,
    frames: 0,
    bytes: 0,
    jsonFrames: 0,
    candidates: 0,
    callouts: 0,
    lastFrameAt: null,
    lastTradingActivityAt: null,
    lastThesisAt: null,
    lastCalloutAt: null,
    lastFrameType: null,
    lastFrameTopic: null,
    lastPayloadType: null,
    frameTypes: {},
    frameTopics: {},
    payloadTypes: {},
    calloutRejectionReasons: {},
    tradingActivityFrames: 0,
    thesisFrames: 0,
    unnormalizedThesisFrames: 0,
    distinctFrameFingerprints: 0,
    repeatedFrames: 0,
    webSocketsCreated: 0,
    fomoWebSocketsCreated: 0,
    fomoWebSocketsClosed: 0,
    fomoWebSocketErrors: 0,
    activeFomoWebSockets: 0,
    lastFomoWebSocketCreatedAt: null,
    lastFomoWebSocketClosedAt: null,
    lastFomoWebSocketErrorAt: null,
    crashReloads: 0,
    crashReloadErrors: 0,
    lastCrashReloadAt: null,
    pageResets: 0,
    pageResetErrors: 0,
    lastPageResetAt: null,
    detachErrors: 0,
    detachTimeouts: 0,
    lastDetachErrorCode: null,
  };

  function statusSnapshot() {
    return {
      ...status,
      frameTypes: { ...status.frameTypes },
      frameTopics: { ...status.frameTopics },
      payloadTypes: { ...status.payloadTypes },
      calloutRejectionReasons: { ...status.calloutRejectionReasons },
    };
  }

  function emitStatus(state, extra = {}) {
    onStatus({ state, ...extra, metrics: statusSnapshot() });
  }

  function reportError(error, code) {
    onError(safeError(error, code));
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    const delayMs = Math.round(reconnectMs * (0.8 + (random() * 0.4)));
    status.reconnects += 1;
    emitStatus('reconnecting', { delayMs });
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
  }

  function handleWebSocketCreated(event = {}) {
    status.webSocketsCreated += 1;
    if (!event.requestId || !isFomoWebSocketUrl(event.url)) return;
    fomoWebSockets.add(event.requestId);
    status.fomoWebSocketsCreated += 1;
    status.activeFomoWebSockets = fomoWebSockets.size;
    status.lastFomoWebSocketCreatedAt = new Date().toISOString();
  }

  function handleWebSocketClosed(event = {}) {
    if (!fomoWebSockets.delete(event.requestId)) return;
    status.fomoWebSocketsClosed += 1;
    status.activeFomoWebSockets = fomoWebSockets.size;
    status.lastFomoWebSocketClosedAt = new Date().toISOString();
  }

  function handleWebSocketFrameError(event = {}) {
    if (!fomoWebSockets.has(event.requestId)) return;
    status.fomoWebSocketErrors += 1;
    status.lastFomoWebSocketErrorAt = new Date().toISOString();
  }

  function handleFrame(event) {
    const payload = event?.response?.payloadData;
    if (typeof payload !== 'string') return;
    const evidence = normalizeFomoFrame(payload, { binary: event.response.opcode === 2 });
    status.frames += 1;
    status.bytes += evidence.byteLength;
    status.lastFrameAt = new Date().toISOString();
    status.lastFrameType = telemetryLabel(evidence.eventType);
    status.lastFrameTopic = telemetryLabel(evidence.topic);
    status.lastPayloadType = telemetryLabel(evidence.payloadType);
    incrementLabelCounter(status.frameTypes, evidence.eventType);
    incrementLabelCounter(status.frameTopics, evidence.topic);
    incrementLabelCounter(status.payloadTypes, evidence.payloadType);
    if (frameFingerprints.has(evidence.fingerprint)) status.repeatedFrames += 1;
    else if (frameFingerprints.size < 256) {
      frameFingerprints.add(evidence.fingerprint);
      status.distinctFrameFingerprints = frameFingerprints.size;
    }
    onFrame({ at: status.lastFrameAt });
    if (evidence.frameKind === 'json') status.jsonFrames += 1;
    if (evidence.tradingActivityCandidate) {
      status.tradingActivityFrames += 1;
      status.lastTradingActivityAt = status.lastFrameAt;
    }
    if (evidence.payloadType === 'thesis') {
      status.thesisFrames += 1;
      status.lastThesisAt = status.lastFrameAt;
      if (!evidence.callout) {
        status.unnormalizedThesisFrames += 1;
        incrementLabelCounter(
          status.calloutRejectionReasons, evidence.calloutRejectionReason,
        );
      }
    }
    if (!evidence.tradingActivityCandidate && !evidence.callout) return;
    status.candidates += 1;
    if (evidence.callout) {
      status.callouts += 1;
      status.lastCalloutAt = status.lastFrameAt;
    }
    onEvidence(evidence);
  }

  function handleDisconnect() {
    if (!status.connected) return;
    status.connected = false;
    emitStatus('closed');
    scheduleReconnect();
  }

  function handlePageCrash() {
    void reloadCrashedPage();
  }

  async function detach() {
    const attachedPage = page;
    const attachedBrowser = browser;
    const attachedSession = session;
    session = null;
    page = null;
    browser = null;
    attachedPage?.off?.('close', handleDisconnect);
    attachedPage?.off?.('crash', handlePageCrash);
    attachedBrowser?.off?.('disconnected', handleDisconnect);
    attachedSession?.off?.('Network.webSocketCreated', handleWebSocketCreated);
    attachedSession?.off?.('Network.webSocketClosed', handleWebSocketClosed);
    attachedSession?.off?.('Network.webSocketFrameError', handleWebSocketFrameError);
    attachedSession?.off?.('Network.webSocketFrameReceived', handleFrame);
    fomoWebSockets.clear();
    status.activeFomoWebSockets = 0;
    const result = await detachSession(attachedSession);
    if (!result.ok) {
      status.detachErrors += 1;
      if (result.timedOut) status.detachTimeouts += 1;
      status.lastDetachErrorCode = result.errorCode;
    }
  }

  async function reloadCrashedPage() {
    if (!running || !status.connected || !page || pageReloadRunning) return;
    pageReloadRunning = true;
    status.crashReloads += 1;
    status.lastCrashReloadAt = new Date(now()).toISOString();
    emitStatus('crash_reloading');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: reloadTimeoutMs });
    } catch (error) {
      status.crashReloadErrors += 1;
      reportError(error, 'FOMO_BROWSER_CRASH_RELOAD');
      status.connected = false;
      scheduleReconnect();
      await detach();
    } finally {
      pageReloadRunning = false;
    }
  }

  async function resetPageAfterRepeatedConnectFailure() {
    consecutiveConnectFailures += 1;
    if (consecutiveConnectFailures < CONNECT_FAILURES_BEFORE_PAGE_RESET) return;
    const elapsedMs = lastPageResetMs == null ? Infinity : now() - lastPageResetMs;
    if (elapsedMs < pageResetCooldownMs) return;
    lastPageResetMs = now();
    status.lastPageResetAt = new Date(lastPageResetMs).toISOString();
    try {
      await resetBrowserPage(endpoint);
      status.pageResets += 1;
      consecutiveConnectFailures = 0;
      emitStatus('page_reset');
    } catch (error) {
      status.pageResetErrors += 1;
      reportError(error, 'FOMO_BROWSER_PAGE_RESET');
    }
  }

  async function connect() {
    if (!running || connecting) return;
    connecting = true;
    status.connects += 1;
    emitStatus('connecting');
    try {
      await detach();
      const connectedBrowser = await connectOverCDP(endpoint);
      if (!running) return;
      const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
      const fomoPage = pages.find(isFomoPage);
      if (!fomoPage) {
        const error = new Error('Open fomo.family in the connected Chrome profile');
        error.code = 'FOMO_BROWSER_PAGE_MISSING';
        throw error;
      }
      const cdpSession = await fomoPage.context().newCDPSession(fomoPage);
      await cdpSession.send('Network.enable');
      if (!running) {
        await detachSession(cdpSession);
        return;
      }
      browser = connectedBrowser;
      page = fomoPage;
      session = cdpSession;
      session.on('Network.webSocketCreated', handleWebSocketCreated);
      session.on('Network.webSocketClosed', handleWebSocketClosed);
      session.on('Network.webSocketFrameError', handleWebSocketFrameError);
      session.on('Network.webSocketFrameReceived', handleFrame);
      page.on('close', handleDisconnect);
      page.on('crash', handlePageCrash);
      browser.on('disconnected', handleDisconnect);
      status.connected = true;
      consecutiveConnectFailures = 0;
      reconnectMs = baseReconnectMs;
      emitStatus('connected');
    } catch (error) {
      reportError(error, 'FOMO_BROWSER_CONNECT');
      await detach();
      await resetPageAfterRepeatedConnectFailure();
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    void connect();
  }

  async function stop() {
    running = false;
    status.connected = false;
    if (reconnectTimer) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    await detach();
  }

  return { start, stop, getStatus: () => ({ running, endpoint, ...statusSnapshot() }) };
}

module.exports = {
  createFomoBrowserActivityStream,
  isFomoWebSocketUrl,
  isFomoPage,
  normalizeCdpEndpoint,
  resetFomoBrowserPage,
};
