'use strict';

const { chromium } = require('playwright-core');
const { isFomoPage, normalizeCdpEndpoint } = require('./fomo-browser-activity-stream');
const { detachCdpSession } = require('./fomo-cdp-session');

const API_ORIGIN = 'https://prod-api.fomo.family';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCOVERY_TIMEFRAMES = ['24h', '7d', '30d'];
const USER_ID_CANDIDATES = Object.freeze([
  ['response_object_id', (body) => body?.responseObject?.id],
  ['response_object_user_id', (body) => body?.responseObject?.userId],
  ['response_object_user_object_id', (body) => body?.responseObject?.user?.id],
  ['response_object_profile_id', (body) => body?.responseObject?.profile?.id],
  ['root_id', (body) => body?.id],
  ['root_user_id', (body) => body?.userId],
  ['root_user_object_id', (body) => body?.user?.id],
  ['root_profile_id', (body) => body?.profile?.id],
  ['root_profile_id_field', (body) => body?.profileId],
  ['root_account_id', (body) => body?.account?.id],
  ['root_account_id_field', (body) => body?.accountId],
  ['data_id', (body) => body?.data?.id],
  ['data_user_id', (body) => body?.data?.userId],
  ['data_user_object_id', (body) => body?.data?.user?.id],
  ['data_profile_id', (body) => body?.data?.profile?.id],
  ['data_profile_id_field', (body) => body?.data?.profileId],
  ['data_account_id', (body) => body?.data?.account?.id],
  ['data_account_id_field', (body) => body?.data?.accountId],
  ['payload_id', (body) => body?.payload?.id],
  ['payload_user_id', (body) => body?.payload?.userId],
  ['payload_user_object_id', (body) => body?.payload?.user?.id],
  ['payload_profile_id', (body) => body?.payload?.profile?.id],
  ['payload_profile_id_field', (body) => body?.payload?.profileId],
  ['payload_account_id', (body) => body?.payload?.account?.id],
  ['payload_account_id_field', (body) => body?.payload?.accountId],
  ['root_user_id_snake', (body) => body?.user_id],
  ['root_profile_id_snake', (body) => body?.profile_id],
  ['root_account_id_snake', (body) => body?.account_id],
]);
const BOOTSTRAP_COUNT_FIELDS = Object.freeze([
  'userBootstrapRequests', 'userBootstrapResponses', 'userBootstrapExtraInfoResponses',
  'userBootstrapLoadingFailures', 'userBootstrapBodyReads',
  'userBootstrapBodyReadErrors', 'userBootstrapJsonErrors', 'userBootstrapRequestBodies',
  'userBootstrapRequestBodyParseErrors', 'challengeAcceptedFrames',
]);
const BOOTSTRAP_LAST_FIELDS = Object.freeze([
  'lastUserBootstrapHttpStatus', 'lastUserBootstrapExtraInfoStatus',
  'userBootstrapPendingAtEnd', 'lastUserBootstrapFailureCategory',
  'lastUserBootstrapBlockedReason', 'lastUserBootstrapCorsError',
  'lastUserBootstrapCanceled', 'lastUserBootstrapBodyShape',
  'lastUserBootstrapResponseObjectShape', 'lastUserBootstrapIdentityPath',
  'lastUserBootstrapIdentityFormat', 'lastUserBootstrapRequestBodyEncoding',
  'lastUserBootstrapRequestBodyShape', 'lastUserBootstrapRequestIdentityPath',
  'lastUserBootstrapRequestIdentityFormat', 'lastChallengeAcceptedIdentityPath',
  'lastChallengeAcceptedIdentityFormat', 'lastChallengeAcceptedDataShape',
  'lastChallengeAcceptedPayloadShape', 'lastChallengeAcceptedUserShape',
  'lastChallengeAcceptedProfileShape',
]);

function valueShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function inspectUserBootstrapBody(body) {
  let firstPresent = null;
  for (const [path, read] of USER_ID_CANDIDATES) {
    const value = String(read(body) || '').trim();
    if (!value) continue;
    const candidate = { path, format: UUID.test(value) ? 'uuid' : 'non_uuid', value };
    if (candidate.format === 'uuid') return candidate;
    firstPresent ||= candidate;
  }
  return firstPresent || { path: 'missing', format: 'missing', value: null };
}

function parseRequestBody(request = {}) {
  const text = typeof request.postData === 'string' ? request.postData : '';
  if (!text) return { encoding: 'missing', body: null, parseError: false };
  try {
    return { encoding: 'json', body: JSON.parse(text), parseError: false };
  } catch {}
  const contentType = Object.entries(request.headers || {})
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (String(contentType || '').toLowerCase().includes('application/x-www-form-urlencoded')) {
    try {
      return { encoding: 'form', body: Object.fromEntries(new URLSearchParams(text)), parseError: false };
    } catch {}
  }
  return { encoding: 'other', body: null, parseError: true };
}

function loadingFailureCategory(event = {}) {
  if (event.canceled === true) return 'canceled';
  const text = String(event.errorText || '').toLowerCase();
  if (text.includes('aborted')) return 'aborted';
  if (text.includes('timed_out') || text.includes('timeout')) return 'timed_out';
  if (text.includes('name_not_resolved')) return 'dns';
  if (text.includes('internet_disconnected')) return 'offline';
  if (text.includes('connection_refused')) return 'connection_refused';
  if (text.includes('connection_reset') || text.includes('connection_closed')) return 'connection_lost';
  if (text.includes('blocked')) return 'blocked';
  if (text.includes('cors')) return 'cors';
  return 'other';
}

function blockedReasonCategory(value) {
  const reason = String(value || '').toLowerCase();
  if (!reason) return null;
  if (reason.includes('mixed')) return 'mixed_content';
  if (reason.includes('csp')) return 'csp';
  if (reason.includes('origin') || reason.includes('corp') || reason.includes('coop')) {
    return 'origin_policy';
  }
  if (reason.includes('inspector')) return 'inspector';
  if (reason.includes('subresource')) return 'subresource_filter';
  return 'other';
}

function corsErrorCategory(value) {
  const error = String(value || '').toLowerCase();
  if (!error) return null;
  if (error.includes('preflight')) return 'preflight';
  if (error.includes('alloworigin') || error.includes('origin')) return 'origin';
  if (error.includes('credential')) return 'credentials';
  if (error.includes('header')) return 'header';
  if (error.includes('method')) return 'method';
  return 'other';
}

function mergeBootstrapDiagnostics(status, diagnostics) {
  for (const field of BOOTSTRAP_COUNT_FIELDS) {
    status[field] += Number(diagnostics[field]) || 0;
  }
  for (const field of BOOTSTRAP_LAST_FIELDS) {
    if (diagnostics[field] !== null && diagnostics[field] !== undefined) {
      status[field] = diagnostics[field];
    }
  }
}

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

function nonNegativeInteger(value, fallback, max) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
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
      pending: [], alreadyFollowed: 0, followingCount: null,
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
    followingCount: following.size,
  };
}

async function readActivityProfiles(api, persistence, options = {}) {
  const response = await api.request(
    `/feed/tradingActivity?limit=${options.limit}&threshold=${options.threshold}`,
  );
  const status = responseStatus(response);
  if (status !== 200) {
    const error = new Error('Fomo trading activity profile discovery failed');
    error.code = `FOMO_PROFILE_ACTIVITY_HTTP_${status || 'UNKNOWN'}`;
    throw error;
  }
  const result = responseObject(response);
  const activityItems = Array.isArray(result?.items) ? result.items : [];
  const byProfile = new Map();
  for (const item of activityItems) {
    const profileId = String(item?.userId || '').trim();
    if (profileId && !byProfile.has(profileId)) byProfile.set(profileId, item);
  }
  const missingWalletIds = await persistence.findMissingWalletProfileIds([...byProfile.keys()]);
  const tradeDetails = [];
  let lookupErrors = 0;
  const lookupCandidates = missingWalletIds.map((profileId) => ({
    profileId, tradeId: String(byProfile.get(profileId)?.tradeId || '').trim(),
  })).filter((entry) => entry.tradeId).slice(0, options.tradeLookupLimit);
  for (const { tradeId } of lookupCandidates) {
    try {
      const tradeResponse = await api.request(`/trades/${encodeURIComponent(tradeId)}`);
      if (responseStatus(tradeResponse) === 200) {
        tradeDetails.push({ tradeId, body: tradeResponse.body });
      } else lookupErrors += 1;
    } catch { lookupErrors += 1; }
  }
  return {
    activityItems, tradeDetails, lookupErrors, lookups: lookupCandidates.length,
    profiles: byProfile.size,
  };
}

async function createFomoBrowserApi(options = {}) {
  const endpoint = normalizeCdpEndpoint(options.cdpEndpoint);
  const connectOverCDP = options.connectOverCDP || ((url) => chromium.connectOverCDP(url));
  const detachSession = options.detachCdpSession || detachCdpSession;
  const authWaitMs = positiveInteger(options.authWaitMs, 60_000, 5 * 60_000);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 15_000, 60_000);
  const browser = await connectOverCDP(endpoint);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find(isFomoPage);
  if (!page) throw Object.assign(new Error('Fomo app page is not open'), { code: 'FOMO_FOLLOW_PAGE_MISSING' });
  const cdp = await page.context().newCDPSession(page);
  let authSettled = false;
  let userSettled = false;
  let authSource = null;
  let identitySource = null;
  let timeout;
  let resolveAuthContext;
  let rejectAuthContext;
  let resolveCurrentUserId;
  let rejectCurrentUserId;
  const apiRequestIds = new Set();
  const userRequestIds = new Set();
  const diagnostics = {
    userBootstrapRequests: 0, userBootstrapResponses: 0,
    userBootstrapExtraInfoResponses: 0, userBootstrapLoadingFailures: 0,
    userBootstrapBodyReads: 0, userBootstrapBodyReadErrors: 0,
    userBootstrapJsonErrors: 0, lastUserBootstrapHttpStatus: null,
    userBootstrapRequestBodies: 0, userBootstrapRequestBodyParseErrors: 0,
    challengeAcceptedFrames: 0,
    lastUserBootstrapExtraInfoStatus: null, userBootstrapPendingAtEnd: 0,
    lastUserBootstrapFailureCategory: null, lastUserBootstrapBlockedReason: null,
    lastUserBootstrapCorsError: null, lastUserBootstrapCanceled: null,
    lastUserBootstrapBodyShape: null, lastUserBootstrapResponseObjectShape: null,
    lastUserBootstrapIdentityPath: null, lastUserBootstrapIdentityFormat: null,
    lastUserBootstrapRequestBodyEncoding: null, lastUserBootstrapRequestBodyShape: null,
    lastUserBootstrapRequestIdentityPath: null, lastUserBootstrapRequestIdentityFormat: null,
    lastChallengeAcceptedIdentityPath: null, lastChallengeAcceptedIdentityFormat: null,
    lastChallengeAcceptedDataShape: null, lastChallengeAcceptedPayloadShape: null,
    lastChallengeAcceptedUserShape: null, lastChallengeAcceptedProfileShape: null,
  };

  function diagnosticsSnapshot() {
    return { authSource, identitySource, ...diagnostics, userBootstrapPendingAtEnd: userRequestIds.size };
  }
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

  function settleAuthorization(authorization, supportedChains, source) {
    if (authSettled) return;
    if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) return;
    authSettled = true;
    authSource = source;
    resolveAuthContext({ authorization, supportedChains });
    clearCaptureTimeout();
  }

  function settleCurrentUserId(userId, source) {
    const normalized = String(userId || '').trim();
    if (userSettled || !UUID.test(normalized)) return;
    userSettled = true;
    identitySource = source;
    resolveCurrentUserId(normalized);
    clearCaptureTimeout();
  }

  function inspectHeaders(headers) {
    const entries = Object.entries(headers || {});
    const authorization = entries
      .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const supportedChains = entries
      .find(([name]) => name.toLowerCase() === 'x-supported-chains')?.[1];
    settleAuthorization(authorization, supportedChains, 'http_request');
  }

  function inspectRequest(event) {
    let url;
    try { url = new URL(event?.request?.url); } catch { return; }
    if (url.origin !== API_ORIGIN) return;
    apiRequestIds.add(event.requestId);
    if (event.request.method === 'POST' && url.pathname === '/v2/users') {
      userRequestIds.add(event.requestId);
      diagnostics.userBootstrapRequests += 1;
      const parsed = parseRequestBody(event.request);
      diagnostics.lastUserBootstrapRequestBodyEncoding = parsed.encoding;
      if (parsed.encoding !== 'missing') diagnostics.userBootstrapRequestBodies += 1;
      if (parsed.parseError) diagnostics.userBootstrapRequestBodyParseErrors += 1;
      diagnostics.lastUserBootstrapRequestBodyShape = parsed.body === null
        ? null : valueShape(parsed.body);
      const identity = inspectUserBootstrapBody(parsed.body);
      diagnostics.lastUserBootstrapRequestIdentityPath = identity.path;
      diagnostics.lastUserBootstrapRequestIdentityFormat = identity.format;
    }
    inspectHeaders(event.request.headers);
  }

  function inspectResponse(event) {
    if (!userRequestIds.has(event?.requestId)) return;
    diagnostics.userBootstrapResponses += 1;
    const status = Number(event?.response?.status);
    diagnostics.lastUserBootstrapHttpStatus = Number.isInteger(status) ? status : null;
  }

  function inspectResponseExtraInfo(event) {
    if (!userRequestIds.has(event?.requestId)) return;
    diagnostics.userBootstrapExtraInfoResponses += 1;
    const status = Number(event?.statusCode);
    diagnostics.lastUserBootstrapExtraInfoStatus = Number.isInteger(status) ? status : null;
  }

  function inspectLoadingFailed(event) {
    if (!userRequestIds.delete(event?.requestId)) return;
    diagnostics.userBootstrapLoadingFailures += 1;
    diagnostics.lastUserBootstrapFailureCategory = loadingFailureCategory(event);
    diagnostics.lastUserBootstrapBlockedReason = blockedReasonCategory(event.blockedReason);
    diagnostics.lastUserBootstrapCorsError = corsErrorCategory(event.corsErrorStatus?.corsError);
    diagnostics.lastUserBootstrapCanceled = event.canceled === true;
  }

  function inspectExtraInfo(event) {
    if (apiRequestIds.has(event?.requestId)) inspectHeaders(event.headers);
  }

  function inspectWebSocketFrame(event) {
    let frame;
    try { frame = JSON.parse(event?.response?.payloadData); } catch { return; }
    if (frame?.type === 'challengeResponse' && typeof frame.jwt === 'string') {
      settleAuthorization(`Bearer ${frame.jwt}`, undefined, 'websocket_challenge');
    }
    if (frame?.type === 'subscribe' && frame.topicType === 'trading_activity') {
      settleCurrentUserId(frame.topicId, 'websocket_subscribe');
    }
  }

  function inspectWebSocketFrameReceived(event) {
    let frame;
    try { frame = JSON.parse(event?.response?.payloadData); } catch { return; }
    if (String(frame?.type || '').toLowerCase() !== 'challengeaccepted') return;
    diagnostics.challengeAcceptedFrames += 1;
    const identity = inspectUserBootstrapBody(frame);
    diagnostics.lastChallengeAcceptedIdentityPath = identity.path;
    diagnostics.lastChallengeAcceptedIdentityFormat = identity.format;
    diagnostics.lastChallengeAcceptedDataShape = valueShape(frame.data);
    diagnostics.lastChallengeAcceptedPayloadShape = valueShape(frame.payload);
    diagnostics.lastChallengeAcceptedUserShape = valueShape(frame.user);
    diagnostics.lastChallengeAcceptedProfileShape = valueShape(frame.profile);
  }

  async function inspectLoadingFinished(event) {
    if (!userRequestIds.delete(event?.requestId)) return;
    try {
      const result = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
      diagnostics.userBootstrapBodyReads += 1;
      const text = result.base64Encoded
        ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
      let body;
      try { body = JSON.parse(text); } catch {
        diagnostics.userBootstrapJsonErrors += 1;
        diagnostics.lastUserBootstrapBodyShape = 'invalid_json';
        return;
      }
      const identity = inspectUserBootstrapBody(body);
      diagnostics.lastUserBootstrapBodyShape = valueShape(body);
      diagnostics.lastUserBootstrapResponseObjectShape = valueShape(body?.responseObject);
      diagnostics.lastUserBootstrapIdentityPath = identity.path;
      diagnostics.lastUserBootstrapIdentityFormat = identity.format;
      settleCurrentUserId(body?.responseObject?.id, 'user_response');
    } catch {
      diagnostics.userBootstrapBodyReadErrors += 1;
    }
  }

  function removeCaptureListeners() {
    cdp.off('Network.requestWillBeSent', inspectRequest);
    cdp.off('Network.responseReceived', inspectResponse);
    cdp.off('Network.responseReceivedExtraInfo', inspectResponseExtraInfo);
    cdp.off('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
    cdp.off('Network.loadingFinished', inspectLoadingFinished);
    cdp.off('Network.loadingFailed', inspectLoadingFailed);
    cdp.off('Network.webSocketFrameSent', inspectWebSocketFrame);
    cdp.off('Network.webSocketFrameReceived', inspectWebSocketFrameReceived);
  }

  cdp.on('Network.requestWillBeSent', inspectRequest);
  cdp.on('Network.responseReceived', inspectResponse);
  cdp.on('Network.responseReceivedExtraInfo', inspectResponseExtraInfo);
  cdp.on('Network.requestWillBeSentExtraInfo', inspectExtraInfo);
  cdp.on('Network.loadingFinished', inspectLoadingFinished);
  cdp.on('Network.loadingFailed', inspectLoadingFailed);
  cdp.on('Network.webSocketFrameSent', inspectWebSocketFrame);
  cdp.on('Network.webSocketFrameReceived', inspectWebSocketFrameReceived);
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
    removeCaptureListeners();
    await detachSession(cdp);
    const failure = error instanceof Error ? error : new Error('Fomo browser API capture failed');
    failure.fomoDiagnostics = diagnosticsSnapshot();
    throw failure;
  }
  removeCaptureListeners();

  return {
    currentUserId,
    diagnostics: diagnosticsSnapshot(),
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
      return detachSession(cdp);
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
  const activityDiscoveryEnabled = options.activityDiscoveryEnabled === true;
  const activityLimit = positiveInteger(options.activityLimit, 50, 50);
  const activityThreshold = nonNegativeInteger(options.activityThreshold, 0, 1_000_000_000);
  const activityTradeLookupLimit = nonNegativeInteger(options.activityTradeLookupLimit, 5, 10);
  const maxFollows = positiveInteger(options.maxFollowsPerRun, 1, 10);
  const intervalMs = positiveInteger(options.intervalMs, 5 * 60_000, 24 * 60 * 60_000);
  const autoResumeMs = positiveInteger(options.autoResumeMs, 5 * 60_000, 24 * 60 * 60_000);
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
    enabled, followEnabled, dryRun, discoveryEnabled, activityDiscoveryEnabled,
    running: false, discovered: 0, activityProfiles: 0, activityTradeLookups: 0,
    activityTradeLookupErrors: 0, activityDiscoveryErrors: 0,
    lastActivityDiscoveryAt: null, lastActivityDiscoveryErrorCode: null,
    planned: 0, followed: 0, alreadyFollowed: 0,
    followingSnapshotSize: null, lastFollowingReadAt: null,
    followAttempts: 0, followFailures: 0, lastFollowHttpStatus: null,
    lastFollowAttemptAt: null, lastFollowSuccessAt: null, lastFollowFailureAt: null,
    persistedProfiles: 0, persistedWallets: 0, lastDiscoveryPersistedAt: null,
    profilePersistenceErrors: 0, lastProfilePersistenceErrorCode: null,
    cycles: 0, phase: 'idle', intervalMs, lastStartedAt: null, nextRunAt: null,
    errors: 0, paused: false, pausePersisted: false, pausedAt: null,
    autoResumeMs, resumeAt: null, autoResumes: 0, lastAutoResumedAt: null,
    lastErrorCode: null, alertSentAt: null, alertErrors: 0,
    lastFailureCode: null, lastFailureAt: null, lastFailurePhase: null,
    lastApiReadyAt: null, lastAuthSource: null, lastIdentitySource: null,
    userBootstrapRequests: 0, userBootstrapResponses: 0,
    userBootstrapExtraInfoResponses: 0, userBootstrapLoadingFailures: 0,
    userBootstrapBodyReads: 0, userBootstrapBodyReadErrors: 0,
    userBootstrapJsonErrors: 0, lastUserBootstrapHttpStatus: null,
    userBootstrapRequestBodies: 0, userBootstrapRequestBodyParseErrors: 0,
    challengeAcceptedFrames: 0,
    lastUserBootstrapExtraInfoStatus: null, userBootstrapPendingAtEnd: 0,
    lastUserBootstrapFailureCategory: null, lastUserBootstrapBlockedReason: null,
    lastUserBootstrapCorsError: null, lastUserBootstrapCanceled: null,
    lastUserBootstrapBodyShape: null, lastUserBootstrapResponseObjectShape: null,
    lastUserBootstrapIdentityPath: null, lastUserBootstrapIdentityFormat: null,
    lastUserBootstrapRequestBodyEncoding: null, lastUserBootstrapRequestBodyShape: null,
    lastUserBootstrapRequestIdentityPath: null, lastUserBootstrapRequestIdentityFormat: null,
    lastChallengeAcceptedIdentityPath: null, lastChallengeAcceptedIdentityFormat: null,
    lastChallengeAcceptedDataShape: null, lastChallengeAcceptedPayloadShape: null,
    lastChallengeAcceptedUserShape: null, lastChallengeAcceptedProfileShape: null,
    lastAlertErrorCode: null, completedAt: null,
    cdpDetachErrors: 0, cdpDetachTimeouts: 0, lastCdpDetachErrorCode: null,
  };

  function fail(error, code) {
    const failureCode = String(error?.code || code || 'FOMO_FOLLOW_ERROR');
    status.errors += 1;
    status.lastErrorCode = failureCode;
    status.lastFailureCode = failureCode;
    status.lastFailureAt = new Date(now()).toISOString();
    status.lastFailurePhase = status.phase;
  }

  function pauseState() {
    return {
      paused: true, pausedAt: status.pausedAt,
      resumeAt: status.resumeAt, lastErrorCode: status.lastErrorCode,
      alertSentAt: status.alertSentAt,
    };
  }

  async function notifyPause() {
    if (!pauseNotifier || status.alertSentAt) return;
    try {
      await pauseNotifier.sendPauseAlert({
        pausedAt: status.pausedAt, resumeAt: status.resumeAt,
        lastErrorCode: status.lastErrorCode,
      });
      status.alertSentAt = new Date(now()).toISOString();
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
    status.pausedAt ||= new Date(now()).toISOString();
    status.resumeAt ||= new Date(Date.parse(status.pausedAt) + autoResumeMs).toISOString();
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
      status.followAttempts += 1;
      status.lastFollowAttemptAt = new Date(now()).toISOString();
      let response;
      try {
        response = await api.request('/follows', {
          method: 'POST', body: { user_id: userId, following_id: targetId },
        });
      } catch (error) {
        status.followFailures += 1;
        status.lastFollowFailureAt = new Date(now()).toISOString();
        throw error;
      }
      const code = responseStatus(response);
      status.lastFollowHttpStatus = code || null;
      if (code === 200) {
        status.followed += 1;
        status.lastFollowSuccessAt = new Date(now()).toISOString();
        continue;
      }
      status.followFailures += 1;
      status.lastFollowFailureAt = new Date(now()).toISOString();
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
    const pausedAtMs = Date.parse(status.pausedAt);
    status.resumeAt = saved.resumeAt || (Number.isFinite(pausedAtMs)
      ? new Date(pausedAtMs + autoResumeMs).toISOString() : null);
    status.lastErrorCode = saved.lastErrorCode || 'FOMO_FOLLOW_PAUSED';
    status.lastFailureCode ||= status.lastErrorCode;
    status.lastFailureAt ||= status.pausedAt;
    status.lastFailurePhase ||= 'restored_pause';
    status.alertSentAt = saved.alertSentAt || null;
    const resumeAtMs = Date.parse(status.resumeAt);
    if (Number.isFinite(resumeAtMs) && now() >= resumeAtMs) {
      const resumedAt = new Date(now()).toISOString();
      try {
        await stateStore.save({ paused: false, lastAutoResumedAt: resumedAt });
      } catch {
        status.errors += 1;
        return true;
      }
      status.paused = false;
      status.pausePersisted = false;
      status.pausedAt = null;
      status.resumeAt = null;
      status.lastErrorCode = null;
      status.alertSentAt = null;
      status.autoResumes += 1;
      status.lastAutoResumedAt = resumedAt;
      return false;
    }
    await notifyPause();
    return !profilePersistence;
  }

  async function persistDiscoveredProfiles(entries, activity) {
    if (!profilePersistence) return;
    try {
      const persisted = await profilePersistence.persist(entries, activity);
      status.persistedProfiles = persisted.profiles;
      status.persistedWallets = persisted.wallets;
      status.lastDiscoveryPersistedAt = persisted.persistedAt;
      status.lastProfilePersistenceErrorCode = null;
    } catch (error) {
      status.profilePersistenceErrors += 1;
      status.lastProfilePersistenceErrorCode = String(
        error?.code || 'FOMO_PROFILE_PERSISTENCE_ERROR',
      );
    }
  }

  async function discoverActivityProfiles(api) {
    if (!activityDiscoveryEnabled || !profilePersistence) return {};
    try {
      const activity = await readActivityProfiles(api, profilePersistence, {
        limit: activityLimit, threshold: activityThreshold,
        tradeLookupLimit: activityTradeLookupLimit,
      });
      status.activityProfiles = activity.profiles;
      status.activityTradeLookups = activity.lookups;
      status.activityTradeLookupErrors += activity.lookupErrors;
      status.lastActivityDiscoveryAt = new Date().toISOString();
      status.lastActivityDiscoveryErrorCode = null;
      return activity;
    } catch (error) {
      status.activityDiscoveryErrors += 1;
      status.lastActivityDiscoveryErrorCode = String(
        error?.code || 'FOMO_PROFILE_ACTIVITY_DISCOVERY_ERROR',
      );
      return {};
    }
  }

  async function handleRunError(error) {
    if (followEnabled && !status.paused) await pause(error);
    else fail(error, 'FOMO_PROFILE_DISCOVERY_ERROR');
  }

  function recordApiReady(api) {
    status.lastApiReadyAt = new Date(now()).toISOString();
    recordApiDiagnostics(api.diagnostics);
  }

  function recordApiDiagnostics(diagnostics) {
    if (!diagnostics) return;
    status.lastAuthSource = diagnostics.authSource || status.lastAuthSource;
    status.lastIdentitySource = diagnostics.identitySource || status.lastIdentitySource;
    mergeBootstrapDiagnostics(status, diagnostics);
  }

  function recordFollowPlan(plan) {
    status.discovered = plan.discovered;
    status.alreadyFollowed = plan.alreadyFollowed;
    status.planned = plan.pending.length;
    status.followingSnapshotSize = plan.followingCount;
    if (plan.followingCount != null) status.lastFollowingReadAt = new Date(now()).toISOString();
  }

  async function closeApi(api) {
    status.phase = 'cleanup';
    const detachResult = await api?.close?.();
    if (detachResult?.ok === false) {
      status.cdpDetachErrors += 1;
      if (detachResult.timedOut) status.cdpDetachTimeouts += 1;
      status.lastCdpDetachErrorCode = detachResult.errorCode;
    }
    status.completedAt = new Date(now()).toISOString();
    status.phase = 'idle';
  }

  function shouldRun() {
    return enabled && (profileIds.length > 0 || discoveryEnabled || profilePersistence);
  }

  function shouldWriteFollows() {
    return followEnabled && !status.paused && !dryRun;
  }

  async function run() {
    if (!shouldRun()) return;
    let api;
    try {
      status.phase = 'restore_pause';
      if (await restorePause()) return;
      status.phase = 'browser_auth';
      api = await createBrowserApi({
        cdpEndpoint: options.cdpEndpoint,
        authWaitMs: options.authWaitMs,
        requestTimeoutMs: options.requestTimeoutMs,
      });
      recordApiReady(api);
      status.phase = 'follow_plan';
      const plan = await readFollowPlan(api, profileIds, {
        discoveryEnabled, discoveryLimit, followEnabled: followEnabled && !status.paused,
      });
      recordFollowPlan(plan);
      status.phase = 'activity_discovery';
      const activity = await discoverActivityProfiles(api);
      status.phase = 'profile_persistence';
      await persistDiscoveredProfiles(plan.discoveredProfiles, activity);
      if (!shouldWriteFollows()) return;
      status.phase = 'follow_write';
      await writePending(api, plan.userId, plan.pending);
    } catch (error) {
      recordApiDiagnostics(error?.fomoDiagnostics);
      await handleRunError(error);
    } finally {
      await closeApi(api);
    }
  }

  function scheduleNext() {
    if (!started || timer) return;
    status.nextRunAt = new Date(now() + intervalMs).toISOString();
    timer = schedule(() => {
      timer = null;
      status.nextRunAt = null;
      startCycle();
    }, intervalMs);
  }

  function startCycle() {
    if (!started || running) return;
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
  readActivityProfiles,
  responseStatus,
};
