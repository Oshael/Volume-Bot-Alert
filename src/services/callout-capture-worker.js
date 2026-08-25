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

function fileProvider(filePath) {
  const resolved = String(filePath || '').trim();
  return resolved ? async () => (await fs.readFile(path.resolve(resolved), 'utf8')).trim() : undefined;
}

function createCalloutCaptureWorker(deps = {}) {
  let pump = null;
  let fomo = null;
  let pumpPersistence = null;
  let fomoPersistence = null;
  let retention = null;
  let running = false;

  async function start(config = {}) {
    if (running) return;
    const repository = deps.repository || createCalloutCaptureRepository();
    const pumpTokenProvider = fileProvider(config.pump?.authTokenFile);
    const fomoJwtProvider = fileProvider(config.fomo?.jwtFile);
    pumpPersistence = createPumpCalloutPersistence({ repository, checkpointKey: 'pump:live' });
    fomoPersistence = createImmediateCalloutPersistence({ repository, checkpointKey: 'fomo:live' });
    retention = (deps.createRetentionWorker || createCalloutRetentionWorker)({ repository });
    pump = (deps.createPumpCollector || createPumpLocalCollector)({
      client: (deps.createPumpClient || createPumpCalloutClient)({
        authToken: pumpTokenProvider ? undefined : config.pump?.authToken,
        authTokenProvider: pumpTokenProvider,
      }),
      ...pumpPersistence,
      activityIntervalMs: config.pump?.activityIntervalMs,
      leaderboardIntervalMs: config.pump?.leaderboardIntervalMs,
      usersPerRound: config.pump?.usersPerRound,
      userPages: config.pump?.userPages,
      roundDeadlineMs: config.pump?.roundDeadlineMs,
    });
    fomo = (deps.createFomoCollector || createFomoLocalCollector)({
      ...fomoPersistence,
      wsUrl: config.fomo?.wsUrl,
      headers: config.fomo?.origin ? { Origin: config.fomo.origin } : undefined,
      topicId: config.fomo?.topicId,
      authenticationJwt: fomoJwtProvider ? undefined : config.fomo?.jwt,
      authenticationJwtProvider: fomoJwtProvider,
      reconcileIntervalMs: config.fomo?.reconcileIntervalMs,
      tradeLookupLimit: config.fomo?.tradeLookupLimit,
      threshold: config.fomo?.threshold,
    });
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
      pump: pump?.getStatus?.() || null,
      fomo: fomo?.getStatus?.() || null,
      persistence: {
        pump: pumpPersistence?.getStatus?.() || null,
        fomo: fomoPersistence?.getStatus?.() || null,
      },
      retention: retention?.getStatus?.() || null,
    }),
  };
}

const worker = createCalloutCaptureWorker();
module.exports = Object.assign(worker, { createCalloutCaptureWorker, fileProvider });
