'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createCalloutCaptureRepository } = require('../models/callout-capture');
const { createFomoLocalCollector } = require('./fomo-local-collector');
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

function buildFomoCollector(deps, config, persistence, authentication) {
  const jwtProvider = fileProvider(config.jwtFile);
  return (deps.createFomoCollector || createFomoLocalCollector)({
    ...persistence,
    wsUrl: config.wsUrl,
    headers: config.origin ? { Origin: config.origin } : undefined,
    topicId: config.topicId,
    authenticationJwt: jwtProvider ? undefined : config.jwt,
    authenticationJwtProvider: authentication?.getJwt || jwtProvider,
    reconcileIntervalMs: config.reconcileIntervalMs,
    tradeLookupLimit: config.tradeLookupLimit,
    threshold: config.threshold,
  });
}

function createCalloutCaptureWorker(deps = {}) {
  let pump = null;
  let fomo = null;
  let pumpPersistence = null;
  let fomoPersistence = null;
  let retention = null;
  let fomoAuthentication = null;
  let running = false;

  async function start(config = {}) {
    if (running) return;
    const pumpConfig = config.pump || {};
    const fomoConfig = config.fomo || {};
    const repository = deps.repository || createCalloutCaptureRepository();
    fomoAuthentication = createFomoAuthentication(deps, fomoConfig);
    pumpPersistence = createPumpCalloutPersistence({ repository, checkpointKey: 'pump:live' });
    fomoPersistence = createImmediateCalloutPersistence({ repository, checkpointKey: 'fomo:live' });
    retention = (deps.createRetentionWorker || createCalloutRetentionWorker)({ repository });
    pump = buildPumpCollector(deps, pumpConfig, pumpPersistence);
    fomo = buildFomoCollector(deps, fomoConfig, fomoPersistence, fomoAuthentication);
    running = true;
    try {
      retention.start(config.retention);
      fomo.start();
      await pump.start();
    } catch (error) {
      running = false;
      await Promise.allSettled([pump?.stop?.(), fomo?.stop?.(), retention?.stop?.()]);
      throw error;
    }
  }

  async function stop() {
    running = false;
    await Promise.allSettled([pump?.stop?.(), fomo?.stop?.(), retention?.stop?.()]);
    await fomoPersistence?.flush?.();
  }

  return {
    start, stop,
    getStatus: () => ({
      running,
      pump: componentStatus(pump),
      fomo: componentStatus(fomo),
      fomoAuthentication: componentStatus(fomoAuthentication),
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
