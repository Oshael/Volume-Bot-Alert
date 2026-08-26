'use strict';

const { commonCalloutFromFomo, createCalloutEnvelope } = require('./callout-domain');
const { normalizeFomoActivityItem } = require('./fomo-frame-normalizer');
const { normalizeFomoLeaderboardProfile, normalizeFomoTradeIdentity } = require('./fomo-identity-normalizer');
const { createFomoPublicClient } = require('./fomo-public-client');
const { createFomoTradingActivityStream, createTradingActivitySubscribePayload } = require('./fomo-trading-activity-stream');
const { createProfileObservation, createProfileObservationEnvelope } = require('./profile-wallet-domain');

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function nonNegativeInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}

function responseItems(body, key) {
  const value = body?.responseObject?.[key] ?? body?.[key];
  return Array.isArray(value) ? value : [];
}

function createFomoLocalCollector(options = {}) {
  if (!options.eventSpool?.append || !options.identitySpool?.append) throw new TypeError('Fomo collector requires event and identity spools');
  const publicClient = options.publicClient || createFomoPublicClient();
  const streamFactory = options.streamFactory || createFomoTradingActivityStream;
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const intervalMs = positiveInteger(options.reconcileIntervalMs, 15 * 60_000);
  const reconciliationEnabled = options.reconciliationEnabled !== false;
  const lookupLiveTrades = options.lookupLiveTrades !== false;
  const tradeLookupLimit = nonNegativeInteger(options.tradeLookupLimit, 10, 50);
  const maxSeen = positiveInteger(options.maxSeen, 10_000);
  const liveReadyState = options.authenticationJwt || options.authenticationJwtProvider
    ? 'challenge_accepted' : 'connected';
  const seen = new Set();
  let sequence = 0;
  let running = false;
  let timer = null;
  let work = Promise.resolve();
  let reconciliation = null;
  let liveReadyCount = 0;
  const metrics = {
    reconciliations: 0, profiles: 0, wallets: 0, callouts: 0, tradeIdentities: 0,
    duplicates: 0, errors: 0, lastEventAt: null, lastReconciledAt: null, lastErrorCode: null,
  };

  function remember(key) {
    if (seen.has(key)) { metrics.duplicates += 1; return false; }
    seen.add(key);
    if (seen.size > maxSeen) seen.delete(seen.values().next().value);
    return true;
  }

  function reportError(error) {
    metrics.errors += 1;
    metrics.lastErrorCode = String(error?.code || error?.name || 'FOMO_COLLECTOR_ERROR');
    options.onError?.({ code: metrics.lastErrorCode });
  }

  function enqueue(task) {
    work = work.then(task).catch(reportError);
    return work;
  }

  async function append(spool, envelope, metric) {
    if (!remember(envelope.dedupeKey)) return false;
    try {
      await spool.append(envelope);
    } catch (error) {
      seen.delete(envelope.dedupeKey);
      throw error;
    }
    metrics[metric] += 1;
    return true;
  }

  function profileEnvelope(profile, capturedAt, stream) {
    return createProfileObservationEnvelope(profile, { capturedAt, stream, sequence: sequence++ });
  }

  function captureCallout(normalized, source, lookupTrade = true) {
    const callout = commonCalloutFromFomo(normalized);
    if (!callout) return;
    enqueue(async () => {
      const capturedAt = new Date(now()).toISOString();
      const accepted = await append(options.eventSpool,
        createCalloutEnvelope(callout, { capturedAt, stream: source, sequence: sequence++ }), 'callouts');
      if (!accepted) return;
      metrics.lastEventAt = callout.occurredAt || capturedAt;
      const profile = createProfileObservation({
        platform: 'fomo', platformUserId: callout.profile.platformUserId,
        username: callout.profile.username, displayName: callout.profile.displayName,
        profilePictureUrl: callout.profile.profilePictureUrl,
        observedAt: callout.occurredAt || capturedAt, source: `${source}:${callout.platformEventId || 'unknown'}`,
      });
      await append(options.identitySpool, profileEnvelope(profile, capturedAt, source), 'profiles');
      if (!lookupTrade || !callout.sourceMetadata.tradeId) return;
      const result = await publicClient.getTrade(callout.sourceMetadata.tradeId);
      const identity = normalizeFomoTradeIdentity(result.body, { observedAt: capturedAt, tradeId: callout.sourceMetadata.tradeId });
      if (!identity) return;
      if (await append(options.identitySpool, profileEnvelope(identity, capturedAt, 'trade_identity'), 'profiles')) {
        metrics.wallets += identity.wallets.length;
        metrics.tradeIdentities += 1;
      }
    });
  }

  async function reconcile(reason = 'interval') {
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
      const capturedAt = new Date(now()).toISOString();
      const [leaderboard, activity] = await Promise.allSettled([
        publicClient.getLeaderboard('24h', { limit: 100 }),
        publicClient.getTradingActivity({ limit: 50, threshold: options.threshold ?? 1000 }),
      ]);
      if (leaderboard.status === 'rejected') reportError(leaderboard.reason);
      for (const item of responseItems(leaderboard.value?.body, 'leaderboard')) {
        const profile = normalizeFomoLeaderboardProfile(item, { observedAt: capturedAt, source: `leaderboard:24h:${reason}` });
        if (profile) enqueue(async () => {
          if (await append(options.identitySpool, profileEnvelope(profile, capturedAt, 'leaderboard'), 'profiles')) {
            metrics.wallets += profile.wallets.length;
          }
        });
      }
      if (activity.status === 'rejected') reportError(activity.reason);
      responseItems(activity.value?.body, 'items').forEach((item, index) => {
        captureCallout(normalizeFomoActivityItem(item), 'trading_activity_http', index < tradeLookupLimit);
      });
      metrics.reconciliations += 1;
      metrics.lastReconciledAt = capturedAt;
    })().catch(reportError).finally(() => { reconciliation = null; });
    return reconciliation;
  }

  const stream = streamFactory({
    ...(options.streamOptions || {}),
    wsUrl: options.wsUrl,
    headers: options.headers,
    authenticationJwt: options.authenticationJwt,
    authenticationJwtProvider: options.authenticationJwtProvider,
    subscribePayload: createTradingActivitySubscribePayload(options.topicId),
    onEvidence: (evidence) => captureCallout(
      evidence.callout, 'trading_activity_ws', lookupLiveTrades,
    ),
    onError: reportError,
    onStatus: ({ state }) => {
      if (state !== liveReadyState) return;
      liveReadyCount += 1;
      if (reconciliationEnabled && liveReadyCount > 1) reconcile('reconnect');
    },
  });

  function scheduleReconciliation() {
    timer = schedule(async () => {
      await reconcile();
      if (running) scheduleReconciliation();
    }, intervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (reconciliationEnabled) {
        reconcile('bootstrap').finally(() => { if (running) scheduleReconciliation(); });
      }
      stream.start();
    },
    async stop() {
      running = false;
      if (timer) cancelSchedule(timer);
      timer = null;
      await stream.stop();
      await reconciliation;
      await work;
    },
    reconcile,
    flush: async () => { await reconciliation; await work; },
    getStatus: () => ({ running, ...metrics, stream: stream.getStatus() }),
  };
}

module.exports = { createFomoLocalCollector, responseItems };
