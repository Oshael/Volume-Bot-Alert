'use strict';

const { chromium } = require('playwright-core');
const { isFomoPage, normalizeCdpEndpoint } = require('./fomo-browser-activity-stream');

const API_ORIGIN = 'https://prod-api.fomo.family';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCOVERY_TIMEFRAMES = ['24h', '7d', '30d'];

function normalizeProfileIds(values, max = 100) {
  const unique = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim()).filter(Boolean))];
  if (unique.length > max || unique.some((value) => !UUID.test(value))) {
    throw new TypeError(`Fomo follow allowlist must contain at most ${max} UUIDs`);
  }
  return unique;
}

function positiveInteger(value, fallback, max) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function responseStatus(response) {
  return Number(response?.body?.statusCode ?? response?.status) || 0;
}

function responseObject(response) {
  return response?.body?.responseObject ?? response?.body;
}

function requireSuccess(response, phase) {
  const status = responseStatus(response);
  if (status === 200) return responseObject(response);
  const error = new Error(`Fomo follow ${phase} failed`);
  error.code = `FOMO_FOLLOW_HTTP_${status || 'UNKNOWN'}`;
  throw error;
}

function leaderboardProfileIds(result, currentUserId, limit) {
  const profiles = Array.isArray(result?.leaderboard) ? result.leaderboard : [];
  const candidates = profiles
    .filter((profile) => profile?.private !== true
      && profile?.isRestricted !== true
      && profile?.activated !== false)
    .map((profile) => String(profile?.id || '').trim())
    .filter((id) => id !== currentUserId && UUID.test(id));
  return [...new Set(candidates)].slice(0, limit);
}

async function readFollowPlan(api, allowlistedIds, options = {}) {
  const userId = String(api.currentUserId || '').trim();
  if (!UUID.test(userId)) {
    throw Object.assign(new Error('Fomo browser user identity is invalid'), { code: 'FOMO_FOLLOW_PROFILE' });
  }
  let discoveredIds = [];
  const discoveredProfiles = [];
  if (options.discoveryEnabled) {
    for (const timeframe of DISCOVERY_TIMEFRAMES) {
      const discoveryResponse = await api.request(
        `/v2/leaderboard/${timeframe}?limit=${options.discoveryLimit}`,
      );
      if (responseStatus(discoveryResponse) === 404) continue;
      const discoveryResult = requireSuccess(discoveryResponse, `leaderboard ${timeframe} discovery`);
      const leaderboard = Array.isArray(discoveryResult?.leaderboard)
        ? discoveryResult.leaderboard : [];
      discoveredProfiles.push(...leaderboard.map((profile) => ({ timeframe, profile })));
      discoveredIds.push(...leaderboardProfileIds(discoveryResult, userId, options.discoveryLimit));
    }
    discoveredIds = [...new Set(discoveredIds)];
  }
  const profileIds = [...new Set([...allowlistedIds, ...discoveredIds])];
  if (options.followEnabled === false) {
    return {
      userId, discovered: discoveredIds.length, discoveredProfiles,
      pending: [], alreadyFollowed: 0,
    };
  }
  const followingResponse = await api.request('/v2/users/current/followingIds');
  const followingResult = requireSuccess(followingResponse, 'following read');
  const following = new Set(followingResult?.followingIds || []);
  return {
    userId,
    discovered: discoveredIds.length, discoveredProfiles,
    pending: profileIds.filter((id) => !following.has(id)),
    alreadyFollowed: profileIds.filter((id) => following.has(id)).length,
  };
}

async function createFomoBrowserApi(options = {}) {
  const endpoint = normalizeCdpEndpoint(options.cdpEndpoint);
  const connectOverCDP = options.connectOverCDP || ((url) => chromium.connectOverCDP(url));
  const authWaitMs = positiveInteger(options.authWaitMs, 60_000, 5 * 60_000);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 15_000, 60_000);
  const browser = await connectOverCDP(endpoint);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find(isFomoPage);
  if (!page) throw Object.assign(new Error('Fomo app page is not open'), { code: 'FOMO_FOLLOW_PAGE_MISSING' });
  const cdp = await page.context().newCDPSession(page);
  let authSettled = false;
  let userSettled = false;
  let timeout;
  let resolveAuthContext;
  let rejectAuthContext;
  let resolveCurrentUserId;
  let rejectCurrentUserId;
  const apiRequestIds = new Set();
  const userRequestIds = new Set();
  const authContextPromise = new Promise((resolve, reject) => {
    resolveAuthContext = resolve;
    rejectAuthContext = reject;
  });
  const currentUserIdPromise = new Promise((resolve, reject) => {
    resolveCurrentUserId = resolve;
    rejectCurrentUserId = reject;
  });

  function clearCaptureTimeout() {
    if (authSettled && userSettled) clearTimeout(timeout);
  }

  function settleAuthorization(authorization, supportedChains) {
    if (authSettled) return;
    if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) return;
    authSettled = true;
    resolveAuthContext({ authorization, supportedChains });
    clearCaptureTimeout();
  }

  function settleCurrentUserId(userId) {
    const normalized = String(userId || '').trim();
    if (userSettled || !UUID.test(normalized)) return;
    userSettled = true;
    resolveCurrentUserId(normalized);
    clearCaptureTimeout();
  }

  function inspectHeaders(headers) {
    const entries = Object.entries(headers || {});
    const authorization = entries
      .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const supportedChains = entries
      .find(([name]) => name.toLowerCase() === 'x-supported-chains')?.[1];
    settleAuthorization(authorization, supportedChains);
  }

  function inspectRequest(event) {
    let url;
    try { url = new URL(event?.request?.url); } catch { return; }
    if (url.origin !== API_ORIGIN) return;
    apiRequestIds.add(event.requestId);
    if (event.request.method === 'POST' && url.pathname === '/v2/users') {
      userRequestIds.add(event.requestId);
    }
    inspectHeaders(event.request.headers);
  }

  function inspectExtraInfo(event) {
    if (apiRequestIds.has(event?.requestId)) inspectHeaders(event.headers);
  }

  function inspectWebSocketFrame(event) {
    let frame;
    try { frame = JSON.parse(event?.response?.payloadData); } catch { return; }
    if (frame?.type === 'challengeResponse' && typeof frame.jwt === 'string') {
      settleAuthorization(`Bearer ${frame.jwt}`);
    }
    if (frame?.type === 'subscribe' && frame.topicType === 'trading_activity') {
      settleCurrentUserId(frame.topicId);
    }
  }

  async function inspectLoadingFinished(event) {
    if (userSettled || !userRequestIds.delete(event?.requestId)) return;
    try {
      const result = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
      const text = result.base64Encoded
        ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
      const body = JSON.parse(text);
      settleCurrentUserId(body?.responseObject?.id);
    } catch {}
  }

  cdp.on('Network.requestWillBeSent', inspectRequest);
  cdp.on('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
  cdp.on('Network.loadingFinished', inspectLoadingFinished);
  cdp.on('Network.webSocketFrameSent', inspectWebSocketFrame);
  await cdp.send('Network.enable');
  timeout = setTimeout(() => {
    if (!authSettled) {
      authSettled = true;
      rejectAuthContext(Object.assign(new Error('Timed out waiting for browser auth'), {
        code: 'FOMO_FOLLOW_AUTH_TIMEOUT',
      }));
    }
    if (!userSettled) {
      userSettled = true;
      rejectCurrentUserId(Object.assign(new Error('Timed out waiting for Fomo user identity'), {
        code: 'FOMO_FOLLOW_PROFILE_TIMEOUT',
      }));
    }
  }, authWaitMs);
  let authContext;
  let currentUserId;
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    [authContext, currentUserId] = await Promise.all([authContextPromise, currentUserIdPromise]);
  } catch (error) {
    clearTimeout(timeout);
    authSettled = true;
    userSettled = true;
    cdp.off('Network.requestWillBeSent', inspectRequest);
    cdp.off('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
    cdp.off('Network.loadingFinished', inspectLoadingFinished);
    cdp.off('Network.webSocketFrameSent', inspectWebSocketFrame);
    try { await cdp.detach(); } catch {}
    throw error;
  }
  cdp.off('Network.requestWillBeSent', inspectRequest);
  cdp.off('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
  cdp.off('Network.loadingFinished', inspectLoadingFinished);
  cdp.off('Network.webSocketFrameSent', inspectWebSocketFrame);

  return {
    currentUserId,
    async request(path, init = {}) {
      try {
        return await page.evaluate(async ({ apiOrigin, auth, requestPath, requestInit, timeoutMs }) => {
          const headers = { 'Content-Type': 'application/json', Authorization: auth.authorization };
          if (auth.supportedChains) headers['X-Supported-Chains'] = auth.supportedChains;
          const response = await fetch(`${apiOrigin}${requestPath}`, {
            method: requestInit.method || 'GET',
            credentials: 'include',
            headers,
            body: requestInit.body ? JSON.stringify(requestInit.body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = await response.text();
          let body = null;
          try { body = JSON.parse(text); } catch {}
          return { status: response.status, body };
        }, {
          apiOrigin: API_ORIGIN, auth: authContext, requestPath: path,
          requestInit: init, timeoutMs: requestTimeoutMs,
        });
      } catch (error) {
        const requestError = new Error('Fomo browser request failed');
        requestError.code = /timeout|timed out/i.test(String(error?.name || error?.message))
          ? 'FOMO_FOLLOW_REQUEST_TIMEOUT' : 'FOMO_FOLLOW_REQUEST';
        throw requestError;
      }
    },
    async close() {
      try { await cdp.detach(); } catch {}
    },
  };
}

function createFomoBrowserFollowQueue(options = {}) {
  const enabled = options.enabled === true;
  const followEnabled = options.followEnabled !== false;
  const dryRun = options.dryRun !== false;
  const profileIds = normalizeProfileIds(options.profileIds);
  const discoveryEnabled = options.discoveryEnabled === true;
  const discoveryLimit = positiveInteger(options.discoveryLimit, 100, 100);
  const maxFollows = positiveInteger(options.maxFollowsPerRun, 1, 10);
  const intervalMs = positiveInteger(options.intervalMs, 5 * 60_000, 24 * 60 * 60_000);
  const delayMs = positiveInteger(options.delayMs, 7_500, 60_000);
  const random = options.random || Math.random;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || Date.now;
  const createBrowserApi = options.createBrowserApi || createFomoBrowserApi;
  const stateStore = options.stateStore || { load: async () => null, save: async () => {} };
  const profilePersistence = options.profilePersistence;
  const pauseNotifier = options.pauseNotifier;
  let started = false;
  let running = false;
  let work = null;
  let timer = null;
  const status = {
    enabled, followEnabled, dryRun, discoveryEnabled, running: false, discovered: 0,
    planned: 0, followed: 0, alreadyFollowed: 0,
    persistedProfiles: 0, persistedWallets: 0, lastDiscoveryPersistedAt: null,
    cycles: 0, intervalMs, lastStartedAt: null, nextRunAt: null,
    errors: 0, paused: false, pausePersisted: false, pausedAt: null,
    lastErrorCode: null, alertSentAt: null, alertErrors: 0,
    lastAlertErrorCode: null, completedAt: null,
  };

  function fail(error, code) {
    status.errors += 1;
    status.lastErrorCode = String(error?.code || code || 'FOMO_FOLLOW_ERROR');
  }

  function pauseState() {
    return {
      paused: true, pausedAt: status.pausedAt,
      lastErrorCode: status.lastErrorCode, alertSentAt: status.alertSentAt,
    };
  }

  async function notifyPause() {
    if (!pauseNotifier || status.alertSentAt) return;
    try {
      await pauseNotifier.sendPauseAlert({
        pausedAt: status.pausedAt, lastErrorCode: status.lastErrorCode,
      });
      status.alertSentAt = new Date().toISOString();
      await stateStore.save(pauseState());
      status.pausePersisted = true;
    } catch (error) {
      status.alertErrors += 1;
      status.lastAlertErrorCode = String(error?.code || 'FOMO_FOLLOW_ALERT_ERROR');
    }
  }

  async function pause(error, code) {
    if (!status.paused) fail(error, code);
    status.paused = true;
    status.pausedAt ||= new Date().toISOString();
    try {
      await stateStore.save(pauseState());
      status.pausePersisted = true;
    } catch {
      status.errors += 1;
      status.pausePersisted = false;
    }
    await notifyPause();
  }

  async function writePending(api, userId, pending) {
    for (const targetId of pending.slice(0, maxFollows)) {
      await wait(Math.round(delayMs * (0.8 + (random() * 0.4))));
      const response = await api.request('/follows', {
        method: 'POST', body: { user_id: userId, following_id: targetId },
      });
      const code = responseStatus(response);
      if (code === 200) { status.followed += 1; continue; }
      await pause(null, `FOMO_FOLLOW_HTTP_${code || 'UNKNOWN'}`);
      break;
    }
  }

  async function restorePause() {
    if (!followEnabled) return false;
    const saved = await stateStore.load();
    if (saved?.paused !== true) return false;
    status.paused = true;
    status.pausePersisted = true;
    status.pausedAt = saved.pausedAt || null;
    status.lastErrorCode = saved.lastErrorCode || 'FOMO_FOLLOW_PAUSED';
    status.alertSentAt = saved.alertSentAt || null;
    await notifyPause();
    return !profilePersistence;
  }

  async function persistDiscoveredProfiles(entries) {
    if (!profilePersistence) return;
    const persisted = await profilePersistence.persist(entries);
    status.persistedProfiles = persisted.profiles;
    status.persistedWallets = persisted.wallets;
    status.lastDiscoveryPersistedAt = persisted.persistedAt;
  }

  async function handleRunError(error) {
    if (followEnabled && !status.paused) await pause(error);
    else fail(error, 'FOMO_PROFILE_DISCOVERY_ERROR');
  }

  async function run() {
    if (!enabled || (profileIds.length === 0 && !discoveryEnabled && !profilePersistence)) return;
    let api;
    try {
      if (await restorePause()) return;
      api = await createBrowserApi({
        cdpEndpoint: options.cdpEndpoint,
        authWaitMs: options.authWaitMs,
        requestTimeoutMs: options.requestTimeoutMs,
      });
      const plan = await readFollowPlan(api, profileIds, {
        discoveryEnabled, discoveryLimit, followEnabled: followEnabled && !status.paused,
      });
      status.discovered = plan.discovered;
      status.alreadyFollowed = plan.alreadyFollowed;
      status.planned = plan.pending.length;
      await persistDiscoveredProfiles(plan.discoveredProfiles);
      if (!followEnabled || status.paused || dryRun) return;
      await writePending(api, plan.userId, plan.pending);
    } catch (error) {
      await handleRunError(error);
    } finally {
      await api?.close?.();
      status.completedAt = new Date().toISOString();
    }
  }

  function scheduleNext() {
    if (!started || (status.paused && !profilePersistence) || timer) return;
    status.nextRunAt = new Date(now() + intervalMs).toISOString();
    timer = schedule(() => {
      timer = null;
      status.nextRunAt = null;
      startCycle();
    }, intervalMs);
  }

  function startCycle() {
    if (!started || running || (status.paused && !profilePersistence)) return;
    running = true;
    status.running = true;
    status.cycles += 1;
    status.lastStartedAt = new Date(now()).toISOString();
    work = run().finally(() => {
      running = false;
      status.running = false;
      scheduleNext();
    });
  }

  return {
    start() {
      if (started || !enabled) return;
      started = true;
      startCycle();
    },
    async stop() {
      started = false;
      status.nextRunAt = null;
      if (timer) cancelSchedule(timer);
      timer = null;
      await work;
    },
    getStatus: () => ({ ...status }),
  };
}

module.exports = {
  createFomoBrowserApi,
  createFomoBrowserFollowQueue,
  leaderboardProfileIds,
  normalizeProfileIds,
  responseStatus,
};
