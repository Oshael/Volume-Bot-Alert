'use strict';

const { chromium } = require('playwright-core');
const { normalizeFomoFrame } = require('./fomo-frame-normalizer');

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const DEFAULT_STALE_RECOVERY_MS = 90_000;
const DEFAULT_STALE_RECOVERY_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RELOAD_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_RESET_TIMEOUT_MS = 10_000;
const CONNECT_FAILURES_BEFORE_PAGE_RESET = 2;
const DEFAULT_FOMO_PAGE_URL = 'https://fomo.family/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571';

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
  const baseReconnectMs = positiveInteger(options.reconnectMs, DEFAULT_RECONNECT_MS, MAX_RECONNECT_MS);
  const staleRecoveryMs = positiveInteger(
    options.staleRecoveryMs, DEFAULT_STALE_RECOVERY_MS, 60 * 60_000,
  );
  const staleRecoveryCooldownMs = positiveInteger(
    options.staleRecoveryCooldownMs, DEFAULT_STALE_RECOVERY_COOLDOWN_MS, 60 * 60_000,
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
  let staleTimer = null;
  let pageReloadRunning = false;
  let lastPageReloadMs = null;
  let consecutiveConnectFailures = 0;
  let lastPageResetMs = null;
  let reconnectMs = baseReconnectMs;
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
    staleReloads: 0,
    staleReloadErrors: 0,
    lastStaleReloadAt: null,
    crashReloads: 0,
    crashReloadErrors: 0,
    lastCrashReloadAt: null,
    pageResets: 0,
    pageResetErrors: 0,
    lastPageResetAt: null,
  };

  function emitStatus(state, extra = {}) {
    onStatus({ state, ...extra, metrics: { ...status } });
  }

  function reportError(error, code) {
    onError(safeError(error, code));
  }

  function clearStaleTimer() {
    if (staleTimer) cancelSchedule(staleTimer);
    staleTimer = null;
  }

  function armStaleRecovery(delayMs = staleRecoveryMs) {
    clearStaleTimer();
    if (!running || !status.connected || !page) return;
    staleTimer = schedule(() => {
      staleTimer = null;
      void reloadPage('stale');
    }, delayMs);
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

  function handleFrame(event) {
    const payload = event?.response?.payloadData;
    if (typeof payload !== 'string') return;
    const evidence = normalizeFomoFrame(payload, { binary: event.response.opcode === 2 });
    status.frames += 1;
    status.bytes += evidence.byteLength;
    status.lastFrameAt = new Date().toISOString();
    armStaleRecovery();
    onFrame({ at: status.lastFrameAt });
    if (evidence.frameKind === 'json') status.jsonFrames += 1;
    if (!evidence.tradingActivityCandidate && !evidence.callout) return;
    status.candidates += 1;
    if (evidence.callout) status.callouts += 1;
    onEvidence(evidence);
  }

  function handleDisconnect() {
    if (!status.connected) return;
    clearStaleTimer();
    status.connected = false;
    emitStatus('closed');
    scheduleReconnect();
  }

  function handlePageCrash() {
    void reloadPage('crash');
  }

  async function detach() {
    clearStaleTimer();
    page?.off?.('close', handleDisconnect);
    page?.off?.('crash', handlePageCrash);
    browser?.off?.('disconnected', handleDisconnect);
    if (session) {
      session.off?.('Network.webSocketFrameReceived', handleFrame);
      try { await session.detach(); } catch {}
    }
    session = null;
    page = null;
    browser = null;
  }

  async function reloadPage(reason) {
    if (!running || !status.connected || !page || pageReloadRunning) return;
    const elapsedMs = lastPageReloadMs == null ? Infinity : now() - lastPageReloadMs;
    if (elapsedMs < staleRecoveryCooldownMs) {
      armStaleRecovery(staleRecoveryCooldownMs - elapsedMs);
      return;
    }
    clearStaleTimer();
    pageReloadRunning = true;
    lastPageReloadMs = now();
    const crashed = reason === 'crash';
    const timestamp = new Date(lastPageReloadMs).toISOString();
    if (crashed) {
      status.crashReloads += 1;
      status.lastCrashReloadAt = timestamp;
    } else {
      status.staleReloads += 1;
      status.lastStaleReloadAt = timestamp;
    }
    emitStatus(crashed ? 'crash_reloading' : 'stale_reloading');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: reloadTimeoutMs });
      armStaleRecovery();
    } catch (error) {
      if (crashed) status.crashReloadErrors += 1;
      else status.staleReloadErrors += 1;
      reportError(error, crashed ? 'FOMO_BROWSER_CRASH_RELOAD' : 'FOMO_BROWSER_STALE_RELOAD');
      status.connected = false;
      await detach();
      scheduleReconnect();
    } finally {
      pageReloadRunning = false;
    }
  }

  async function resetPageAfterRepeatedConnectFailure() {
    consecutiveConnectFailures += 1;
    if (consecutiveConnectFailures < CONNECT_FAILURES_BEFORE_PAGE_RESET) return;
    const elapsedMs = lastPageResetMs == null ? Infinity : now() - lastPageResetMs;
    if (elapsedMs < staleRecoveryCooldownMs) return;
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
        await cdpSession.detach();
        return;
      }
      browser = connectedBrowser;
      page = fomoPage;
      session = cdpSession;
      session.on('Network.webSocketFrameReceived', handleFrame);
      page.on('close', handleDisconnect);
      page.on('crash', handlePageCrash);
      browser.on('disconnected', handleDisconnect);
      status.connected = true;
      consecutiveConnectFailures = 0;
      reconnectMs = baseReconnectMs;
      armStaleRecovery();
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
    clearStaleTimer();
    await detach();
  }

  return { start, stop, getStatus: () => ({ running, endpoint, ...status }) };
}

module.exports = {
  createFomoBrowserActivityStream,
  isFomoPage,
  normalizeCdpEndpoint,
  resetFomoBrowserPage,
};
