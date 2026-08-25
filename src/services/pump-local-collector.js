'use strict';

const { commonCalloutFromPump, createCalloutEnvelope } = require('./callout-domain');
const { normalizePumpActivity, normalizePumpProfile } = require('./pump-callout-normalizer');
const { createProfileObservation, createProfileObservationEnvelope } = require('./profile-wallet-domain');

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function rows(body, key) {
  const value = body?.[key] ?? body?.data?.[key];
  return Array.isArray(value) ? value : [];
}

function initialState(value = {}) {
  return {
    version: 1,
    watchlist: [...new Set((Array.isArray(value.watchlist) ? value.watchlist : []).map(String).filter(Boolean))],
    markers: value.markers && typeof value.markers === 'object' ? { ...value.markers } : {},
    recentEventIds: (Array.isArray(value.recentEventIds) ? value.recentEventIds : []).map(String).slice(-2000),
    followingCursor: value.followingCursor || null,
    watchlistOffset: Number.isSafeInteger(value.watchlistOffset) ? value.watchlistOffset : 0,
    lastLeaderboardAt: Number.isFinite(value.lastLeaderboardAt) ? value.lastLeaderboardAt : 0,
  };
}

function createPumpLocalCollector(options = {}) {
  if (!options.client || !options.eventSpool?.append || !options.identitySpool?.append || !options.stateStore) {
    throw new TypeError('Pump collector requires client, spools and state store');
  }
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const activityIntervalMs = positiveInteger(options.activityIntervalMs, 60_000);
  const leaderboardIntervalMs = positiveInteger(options.leaderboardIntervalMs, 15 * 60_000);
  const roundDeadlineMs = positiveInteger(options.roundDeadlineMs, 45_000);
  const usersPerRound = positiveInteger(options.usersPerRound, 5, 50);
  const userPages = positiveInteger(options.userPages, 2, 5);
  let state = null;
  let running = false;
  let paused = false;
  let timer = null;
  let failures = 0;
  let sequence = 0;
  let phase = 'idle';
  const metrics = {
    rounds: 0, profiles: 0, wallets: 0, callouts: 0, duplicates: 0, truncatedUsers: 0, errors: 0,
    lastRoundAt: null, lastEventAt: null, lastErrorCode: null, lastErrorMessage: null,
    lastErrorPhase: null, pauseReason: null,
  };

  async function ensureState() {
    if (!state) state = initialState(await options.stateStore.load());
  }

  function reportError(error) {
    metrics.errors += 1;
    metrics.lastErrorCode = String(error?.code || error?.name || 'PUMP_COLLECTOR_ERROR');
    metrics.lastErrorMessage = String(error?.message || 'Pump collector failed').slice(0, 300);
    metrics.lastErrorPhase = phase;
    options.onError?.({
      code: metrics.lastErrorCode,
      message: metrics.lastErrorMessage,
      phase: metrics.lastErrorPhase,
    });
  }

  async function appendProfile(normalized, capturedAt, source) {
    if (!normalized?.platformUserId) return;
    const profile = createProfileObservation({
      platform: 'pump', platformUserId: normalized.platformUserId,
      username: normalized.username, xUsername: normalized.xUsername,
      displayName: normalized.displayName, profilePictureUrl: normalized.profilePictureUrl,
      observedAt: capturedAt, source,
      wallets: (normalized.wallets || []).map((wallet) => ({
        ...wallet,
        relationType: wallet.relationType || 'profile_wallet',
        sourceType: wallet.sourceType || 'platform_reported',
        confidence: wallet.confidence || 'high',
      })),
    });
    await options.identitySpool.append(createProfileObservationEnvelope(profile, {
      capturedAt, stream: source, sequence: sequence++,
    }));
    metrics.profiles += 1;
    metrics.wallets += profile.wallets.length;
  }

  async function capture(item, source, capturedAt) {
    const normalized = normalizePumpActivity(item);
    const callout = commonCalloutFromPump(normalized);
    if (!callout) return;
    const eventId = callout.platformEventId;
    if (eventId && state.recentEventIds.includes(eventId)) { metrics.duplicates += 1; return; }
    await options.eventSpool.append(createCalloutEnvelope(callout, { capturedAt, stream: source, sequence: sequence++ }));
    metrics.callouts += 1;
    const eventAt = callout.occurredAt || capturedAt;
    if (!metrics.lastEventAt || Date.parse(eventAt) > Date.parse(metrics.lastEventAt)) metrics.lastEventAt = eventAt;
    if (callout.profile.platformUserId) {
      await appendProfile({
        platformUserId: callout.profile.platformUserId,
        username: callout.profile.username,
        xUsername: callout.profile.xUsername,
        profilePictureUrl: callout.profile.profilePictureUrl,
        wallets: callout.wallet?.addressOriginal ? [{
          address: callout.wallet.addressOriginal, rawChainId: callout.wallet.rawChainId,
          sourceField: 'activity.walletAddress', sourceType: 'activity_used', relationType: 'activity_wallet',
        }] : [],
      }, capturedAt, `${source}:${eventId || 'unknown'}`);
    }
    if (eventId) state.recentEventIds = [...state.recentEventIds, eventId].slice(-2000);
  }

  async function discover(capturedAt) {
    const result = await options.client.getLeaderboard({ limit: 50 });
    for (const item of rows(result.body, 'callouts')) {
      const profile = normalizePumpProfile(item);
      if (!profile.platformUserId) continue;
      if (!state.watchlist.includes(profile.platformUserId)) state.watchlist.push(profile.platformUserId);
      await appendProfile(profile, capturedAt, 'leaderboard');
    }
    state.lastLeaderboardAt = now();
  }

  async function captureFollowing(capturedAt) {
    const result = await options.client.listFollowingAlerts({ pageSize: 50, cursor: state.followingCursor });
    for (const item of rows(result.body, 'items')) await capture(item, 'following_alerts', capturedAt);
    state.followingCursor = result.body?.nextCursor || null;
  }

  async function captureWatchlist(capturedAt, deadlineAt) {
    if (!state.watchlist.length) return;
    const count = Math.min(usersPerRound, state.watchlist.length);
    let processed = 0;
    for (let index = 0; index < count && now() < deadlineAt; index += 1) {
      const userId = state.watchlist[(state.watchlistOffset + index) % state.watchlist.length];
      try {
        const marker = state.markers[userId];
        let newest = null;
        let pageToken = null;
        let markerFound = false;
        for (let page = 0; page < userPages && now() < deadlineAt; page += 1) {
          const result = await options.client.listUserCallouts(userId, { limit: 50, pageToken });
          const items = rows(result.body, 'callouts');
          if (!newest && items.length) newest = normalizePumpActivity(items[0]).sourceEventId;
          for (const item of items) {
            const eventId = normalizePumpActivity(item).sourceEventId;
            if (eventId && eventId === marker) { markerFound = true; break; }
            await capture(item, 'user_callouts', capturedAt);
          }
          pageToken = result.body?.nextPageToken || null;
          if (markerFound || !pageToken) break;
          if (page === userPages - 1) metrics.truncatedUsers += 1;
        }
        if (newest) state.markers[userId] = newest;
      } catch (error) {
        if (error?.code === 'PUMP_AUTH' || error?.code === 'PUMP_RATE_LIMIT') throw error;
        reportError(error);
      }
      processed += 1;
    }
    state.watchlistOffset = (state.watchlistOffset + processed) % state.watchlist.length;
  }

  async function runOnce() {
    phase = 'load_state';
    await ensureState();
    const capturedAt = new Date(now()).toISOString();
    const deadlineAt = now() + roundDeadlineMs;
    if (now() - state.lastLeaderboardAt >= leaderboardIntervalMs) {
      phase = 'leaderboard';
      await discover(capturedAt);
    }
    phase = 'following_alerts';
    await captureFollowing(capturedAt);
    phase = 'user_callouts';
    await captureWatchlist(capturedAt, deadlineAt);
    phase = 'persistence';
    await options.stateStore.save(state);
    metrics.rounds += 1;
    metrics.lastRoundAt = capturedAt;
    phase = 'idle';
    return { ...metrics };
  }

  async function tick() {
    let delayMs = activityIntervalMs;
    try { await runOnce(); failures = 0; } catch (error) {
      reportError(error);
      failures += 1;
      if (error?.code === 'PUMP_AUTH') {
        paused = true;
        metrics.pauseReason = 'authentication';
      } else delayMs = error?.retryAfterMs || Math.min(activityIntervalMs * (2 ** failures), 15 * 60_000);
    }
    if (running && !paused) timer = schedule(tick, delayMs);
  }

  return {
    async start() { if (!running) { running = true; await tick(); } },
    stop() { running = false; if (timer) cancelSchedule(timer); timer = null; },
    runOnce,
    getStatus: () => ({ running, paused, phase, watchlistSize: state?.watchlist.length || 0, ...metrics }),
  };
}

module.exports = { createPumpLocalCollector, initialState, rows };
