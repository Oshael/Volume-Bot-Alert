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

async function readFollowPlan(api, profileIds) {
  const [profileResponse, followingResponse] = await Promise.all([
    api.request('/auth/my-profile'),
    api.request('/v2/users/current/followingIds'),
  ]);
  const profile = requireSuccess(profileResponse, 'profile read');
  const followingResult = requireSuccess(followingResponse, 'following read');
  const userId = String(profile?.id || profile?.user?.id || profile?.profile?.id || '').trim();
  if (!UUID.test(userId)) {
    throw Object.assign(new Error('Fomo profile response is invalid'), { code: 'FOMO_FOLLOW_PROFILE' });
  }
  const following = new Set(followingResult?.followingIds || []);
  return {
    userId,
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
  let settled = false;
  let timeout;
  let resolveAuthContext;
  let rejectAuthContext;
  const apiRequestIds = new Set();
  const authContextPromise = new Promise((resolve, reject) => {
    resolveAuthContext = resolve;
    rejectAuthContext = reject;
  });

  function inspectHeaders(headers) {
    if (settled) return;
    const entries = Object.entries(headers || {});
    const authorization = entries
      .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) return;
    const supportedChains = entries
      .find(([name]) => name.toLowerCase() === 'x-supported-chains')?.[1];
    settled = true;
    clearTimeout(timeout);
    resolveAuthContext({ authorization, supportedChains });
  }

  function inspectRequest(event) {
    let url;
    try { url = new URL(event?.request?.url); } catch { return; }
    if (url.origin !== API_ORIGIN) return;
    apiRequestIds.add(event.requestId);
    inspectHeaders(event.request.headers);
  }

  function inspectExtraInfo(event) {
    if (apiRequestIds.has(event?.requestId)) inspectHeaders(event.headers);
  }

  cdp.on('Network.requestWillBeSent', inspectRequest);
  cdp.on('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
  await cdp.send('Network.enable');
  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectAuthContext(Object.assign(new Error('Timed out waiting for browser auth'), {
      code: 'FOMO_FOLLOW_AUTH_TIMEOUT',
    }));
  }, authWaitMs);
  let authContext;
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    authContext = await authContextPromise;
  } catch (error) {
    clearTimeout(timeout);
    settled = true;
    cdp.off('Network.requestWillBeSent', inspectRequest);
    cdp.off('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
    try { await cdp.detach(); } catch {}
    throw error;
  }
  cdp.off('Network.requestWillBeSent', inspectRequest);
  cdp.off('Network.requestWillBeSentExtraInfo', inspectExtraInfo);

  return {
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
  const maxFollows = positiveInteger(options.maxFollowsPerRun, 1, 10);
  const delayMs = positiveInteger(options.delayMs, 7_500, 60_000);
  const random = options.random || Math.random;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createBrowserApi = options.createBrowserApi || createFomoBrowserApi;
  let running = false;
  let work = null;
  const status = {
    enabled, dryRun, running: false, planned: 0, followed: 0, alreadyFollowed: 0,
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
    if (!enabled || profileIds.length === 0) return;
    let api;
    try {
      api = await createBrowserApi({ cdpEndpoint: options.cdpEndpoint, authWaitMs: options.authWaitMs });
      const plan = await readFollowPlan(api, profileIds);
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
  normalizeProfileIds,
  responseStatus,
};
