'use strict';

const { chromium } = require('playwright-core');
const { isFomoPage, normalizeCdpEndpoint } = require('./fomo-browser-activity-stream');

const API_ORIGIN = 'https://prod-api.fomo.family';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAUSE_STATUSES = new Set([401, 403, 429]);

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
  error.pause = PAUSE_STATUSES.has(status);
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
  if (options.discoveryEnabled) {
    const discoveryResponse = await api.request(
      `/v2/leaderboard/24h?limit=${options.discoveryLimit}`,
    );
    const discoveryResult = requireSuccess(discoveryResponse, 'leaderboard discovery');
    discoveredIds = leaderboardProfileIds(discoveryResult, userId, options.discoveryLimit);
  }
  const profileIds = [...new Set([...allowlistedIds, ...discoveredIds])].slice(0, 100);
  const followingResponse = await api.request('/v2/users/current/followingIds');
  const followingResult = requireSuccess(followingResponse, 'following read');
  const following = new Set(followingResult?.followingIds || []);
  return {
    userId,
    discovered: discoveredIds.length,
    pending: profileIds.filter((id) => !following.has(id)),
    alreadyFollowed: profileIds.filter((id) => following.has(id)).length,
  };
}

async function createFomoBrowserApi(options = {}) {
  const endpoint = normalizeCdpEndpoint(options.cdpEndpoint);
  const connectOverCDP = options.connectOverCDP || ((url) => chromium.connectOverCDP(url));
  const authWaitMs = positiveInteger(options.authWaitMs, 60_000, 5 * 60_000);
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
      return page.evaluate(async ({ apiOrigin, auth, requestPath, requestInit }) => {
        const headers = { 'Content-Type': 'application/json', Authorization: auth.authorization };
        if (auth.supportedChains) headers['X-Supported-Chains'] = auth.supportedChains;
        const response = await fetch(`${apiOrigin}${requestPath}`, {
          method: requestInit.method || 'GET',
          credentials: 'include',
          headers,
          body: requestInit.body ? JSON.stringify(requestInit.body) : undefined,
        });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch {}
        return { status: response.status, body };
      }, { apiOrigin: API_ORIGIN, auth: authContext, requestPath: path, requestInit: init });
    },
    async close() {
      try { await cdp.detach(); } catch {}
    },
  };
}

function createFomoBrowserFollowQueue(options = {}) {
  const enabled = options.enabled === true;
  const dryRun = options.dryRun !== false;
  const profileIds = normalizeProfileIds(options.profileIds);
  const discoveryEnabled = options.discoveryEnabled === true;
  const discoveryLimit = positiveInteger(options.discoveryLimit, 25, 100);
  const maxFollows = positiveInteger(options.maxFollowsPerRun, 1, 10);
  const delayMs = positiveInteger(options.delayMs, 7_500, 60_000);
  const random = options.random || Math.random;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createBrowserApi = options.createBrowserApi || createFomoBrowserApi;
  let running = false;
  let work = null;
  const status = {
    enabled, dryRun, discoveryEnabled, running: false, discovered: 0,
    planned: 0, followed: 0, alreadyFollowed: 0,
    errors: 0, paused: false, lastErrorCode: null, completedAt: null,
  };

  function fail(error, code) {
    status.errors += 1;
    status.lastErrorCode = String(error?.code || code || 'FOMO_FOLLOW_ERROR');
  }

  async function writePending(api, userId, pending) {
    for (const targetId of pending.slice(0, maxFollows)) {
      await wait(Math.round(delayMs * (0.8 + (random() * 0.4))));
      const response = await api.request('/follows', {
        method: 'POST', body: { user_id: userId, following_id: targetId },
      });
      const code = responseStatus(response);
      if (code === 200) { status.followed += 1; continue; }
      fail(null, `FOMO_FOLLOW_HTTP_${code || 'UNKNOWN'}`);
      if (PAUSE_STATUSES.has(code)) { status.paused = true; break; }
    }
  }

  async function run() {
    if (!enabled || (profileIds.length === 0 && !discoveryEnabled)) return;
    let api;
    try {
      api = await createBrowserApi({ cdpEndpoint: options.cdpEndpoint, authWaitMs: options.authWaitMs });
      const plan = await readFollowPlan(api, profileIds, { discoveryEnabled, discoveryLimit });
      status.discovered = plan.discovered;
      status.alreadyFollowed = plan.alreadyFollowed;
      status.planned = plan.pending.length;
      if (dryRun) return;
      await writePending(api, plan.userId, plan.pending);
    } catch (error) {
      status.paused = status.paused || error?.pause === true;
      fail(error);
    } finally {
      await api?.close?.();
      status.completedAt = new Date().toISOString();
    }
  }

  return {
    start() {
      if (running || !enabled) return;
      running = true;
      status.running = true;
      work = run().finally(() => { running = false; status.running = false; });
    },
    async stop() { await work; },
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
