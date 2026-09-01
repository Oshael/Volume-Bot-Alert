'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createCalloutCaptureRepository } = require('../models/callout-capture');
const { createFomoLocalCollector } = require('./fomo-local-collector');
const { createFomoBrowserActivityStream } = require('./fomo-browser-activity-stream');
const { createFomoBrowserHealthMonitor } = require('./fomo-browser-health-monitor');
const { createFomoBrowserFollowQueue } = require('./fomo-browser-follow-queue');
const {
  createFomoProfileDiscoveryPersistence,
} = require('./fomo-profile-discovery-persistence');
const { createFomoTelegramOpsNotifier } = require('./fomo-follow-telegram-notifier');
const { createPumpCalloutClient } = require('./pump-callout-client');
const { createPumpLocalCollector } = require('./pump-local-collector');
const {
  createImmediateCalloutPersistence, createPumpCalloutPersistence,
} = require('./callout-capture-persistence');
const { createCalloutRetentionWorker } = require('./callout-retention-worker');
const {
  createAtomicSecretFileStore, createFomoPrivyJwtProvider,
} = require('./fomo-privy-jwt-provider');

function fileProvider(filePath) {
  const resolved = String(filePath || '').trim();
  return resolved ? async () => (await fs.readFile(path.resolve(resolved), 'utf8')).trim() : undefined;
}

function createFomoAuthentication(deps, config) {
  if (!config.privyRefreshTokenFile) return null;
  return (deps.createFomoAuthentication || createFomoPrivyJwtProvider)({
    jwtStore: createAtomicSecretFileStore(config.jwtFile),
    refreshTokenStore: createAtomicSecretFileStore(config.privyRefreshTokenFile),
    sessionUrl: config.privySessionUrl,
    appId: config.privyAppId,
    clientId: config.privyClientId,
    privyClient: config.privyClient,
    clientAnalyticsId: config.privyClientAnalyticsId,
    origin: config.origin,
  });
}

function componentStatus(component) {
  return typeof component?.getStatus === 'function' ? component.getStatus() : null;
}

function buildPumpCollector(deps, config, persistence) {
  const tokenProvider = fileProvider(config.authTokenFile);
  const client = (deps.createPumpClient || createPumpCalloutClient)({
    authToken: tokenProvider ? undefined : config.authToken,
    authTokenProvider: tokenProvider,
  });
  return (deps.createPumpCollector || createPumpLocalCollector)({
    client, ...persistence,
    activityIntervalMs: config.activityIntervalMs,
    leaderboardIntervalMs: config.leaderboardIntervalMs,
    usersPerRound: config.usersPerRound,
    userPages: config.userPages,
    roundDeadlineMs: config.roundDeadlineMs,
  });
}

function buildFomoCollector(deps, config, persistence, authentication, healthMonitor) {
  const browserMode = config.transport === 'browser_cdp';
  const jwtProvider = fileProvider(config.jwtFile);
  return (deps.createFomoCollector || createFomoLocalCollector)({
    ...persistence,
    streamFactory: browserMode
      ? (deps.createFomoBrowserStream || createFomoBrowserActivityStream)
      : undefined,
    streamOptions: browserMode ? {
      cdpEndpoint: config.cdpEndpoint,
      ...(config.browserHealth?.staleMs
        ? { staleRecoveryMs: config.browserHealth.staleMs } : {}),
      ...(config.browserHealth?.recoveryCooldownMs
        ? { staleRecoveryCooldownMs: config.browserHealth.recoveryCooldownMs } : {}),
    } : undefined,
    onStreamFrame: healthMonitor?.onFrame,
    onStreamError: healthMonitor?.onError,
    onStreamStatus: healthMonitor?.onStatus,
    reconciliationEnabled: !browserMode,
    lookupLiveTrades: !browserMode,
    wsUrl: config.wsUrl,
    headers: config.origin ? { Origin: config.origin } : undefined,
    topicId: config.topicId,
    authenticationJwt: jwtProvider ? undefined : config.jwt,
    authenticationJwtProvider: authentication?.getJwt || jwtProvider,
    reconcileIntervalMs: config.reconcileIntervalMs,
    tradeLookupLimit: browserMode ? 0 : config.tradeLookupLimit,
    threshold: config.threshold,
  });
}

function createFomoFollowStateStore(repository) {
  const checkpointKey = 'fomo:follow';
  return {
    async load() {
      return (await repository.loadCheckpoint(checkpointKey))?.state || null;
    },
    async save(state) {
      await repository.commitCapture({
        profileEnvelopes: [], calloutEnvelopes: [], checkpointKey,
        checkpointState: state, committedAt: new Date(),
      });
    },
  };
}

function buildFomoFollowQueue(deps, config, repository, pauseNotifier) {
  const followEnabled = config.follow?.enabled === true;
  const profileDiscoveryEnabled = config.profileDiscovery?.enabled === true;
  if (config.transport !== 'browser_cdp' || (!followEnabled && !profileDiscoveryEnabled)) return null;
  const profilePersistence = profileDiscoveryEnabled
    ? (deps.createFomoProfileDiscoveryPersistence || createFomoProfileDiscoveryPersistence)({ repository })
    : null;
  return (deps.createFomoFollowQueue || createFomoBrowserFollowQueue)({
    ...config.follow, enabled: true, followEnabled,
    discoveryEnabled: config.follow?.discoveryEnabled === true || profileDiscoveryEnabled,
    activityDiscoveryEnabled: profileDiscoveryEnabled,
    activityLimit: config.profileDiscovery?.activityLimit,
    activityThreshold: config.profileDiscovery?.activityThreshold,
    activityTradeLookupLimit: config.profileDiscovery?.activityTradeLookupLimit,
    cdpEndpoint: config.cdpEndpoint, profilePersistence,
    stateStore: createFomoFollowStateStore(repository),
    pauseNotifier,
  });
}

function buildFomoNotifier(deps, config) {
  if (!config.telegramAlerts?.enabled) return null;
  return (deps.createFomoNotifier || createFomoTelegramOpsNotifier)(config.telegramAlerts);
}

function buildFomoHealthMonitor(deps, config, notifier) {
  if (config.transport !== 'browser_cdp' || !config.browserHealth?.enabled || !notifier) return null;
  return (deps.createFomoHealthMonitor || createFomoBrowserHealthMonitor)({
    ...config.browserHealth, notifier,
  });
}

function stopComponents(components) {
  return Promise.allSettled(components.map((component) => component?.stop?.()));
}

function createCalloutCaptureWorker(deps = {}) {
  let pump = null;
  let fomo = null;
  let pumpPersistence = null;
  let fomoPersistence = null;
  let retention = null;
  let fomoAuthentication = null;
  let fomoFollow = null;
  let fomoHealth = null;
  let running = false;

  async function start(config = {}) {
    if (running) return;
    const pumpConfig = config.pump || {};
    const fomoConfig = config.fomo || {};
    const repository = deps.repository || createCalloutCaptureRepository();
    fomoAuthentication = fomoConfig.transport === 'browser_cdp'
      ? null : createFomoAuthentication(deps, fomoConfig);
    pumpPersistence = createPumpCalloutPersistence({ repository, checkpointKey: 'pump:live' });
    fomoPersistence = createImmediateCalloutPersistence({ repository, checkpointKey: 'fomo:live' });
    retention = (deps.createRetentionWorker || createCalloutRetentionWorker)({ repository });
    pump = buildPumpCollector(deps, pumpConfig, pumpPersistence);
    const fomoNotifier = buildFomoNotifier(deps, fomoConfig);
    fomoHealth = buildFomoHealthMonitor(deps, fomoConfig, fomoNotifier);
    fomo = buildFomoCollector(
      deps, fomoConfig, fomoPersistence, fomoAuthentication, fomoHealth,
    );
    fomoFollow = buildFomoFollowQueue(deps, fomoConfig, repository, fomoNotifier);
    running = true;
    try {
      retention.start(config.retention);
      fomoHealth?.start();
      fomo.start();
      fomoFollow?.start();
      await pump.start();
    } catch (error) {
      running = false;
      await stopComponents([pump, fomo, fomoFollow, fomoHealth, retention]);
      throw error;
    }
  }

  async function stop() {
    running = false;
    await stopComponents([pump, fomo, fomoFollow, fomoHealth, retention]);
    await fomoPersistence?.flush?.();
  }

  return {
    start, stop,
    getStatus: () => ({
      running,
      pump: componentStatus(pump),
      fomo: componentStatus(fomo),
      fomoAuthentication: componentStatus(fomoAuthentication),
      fomoFollow: componentStatus(fomoFollow),
      fomoHealth: componentStatus(fomoHealth),
      persistence: {
        pump: componentStatus(pumpPersistence),
        fomo: componentStatus(fomoPersistence),
      },
      retention: componentStatus(retention),
    }),
  };
}

const worker = createCalloutCaptureWorker();
module.exports = Object.assign(worker, { createCalloutCaptureWorker, fileProvider });
