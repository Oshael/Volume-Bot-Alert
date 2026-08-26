'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createImmediateCalloutPersistence, createPumpCalloutPersistence,
} = require('../src/services/callout-capture-persistence');
const { createCalloutCaptureWorker } = require('../src/services/callout-capture-worker');

const NOW = Date.parse('2026-08-25T15:00:00.000Z');
const FOMO_PROFILE = '00000000-0000-4000-8000-00000000000a';

function envelope(kind, key) {
  return {
    dedupeKey: key, capturedAt: new Date(NOW).toISOString(),
    payload: kind === 'callout' ? { eventKind: 'callout' } : { platformUserId: 'profile-1' },
  };
}

describe('callout capture production persistence', () => {
  it('commits a Pump round and its collector state in one repository call', async () => {
    const commits = [];
    const repository = {
      loadCheckpoint: async () => ({ state: { watchlist: ['known'] } }),
      commitCapture: async (input) => commits.push(input),
    };
    const persistence = createPumpCalloutPersistence({ repository, checkpointKey: 'pump:live', now: () => NOW });
    assert.deepEqual(await persistence.stateStore.load(), { watchlist: ['known'] });
    await persistence.eventSpool.append(envelope('callout', 'event-1'));
    await persistence.identitySpool.append(envelope('profile', 'profile-1'));
    await persistence.stateStore.save({ watchlist: ['known'], marker: 'event-1' });

    assert.equal(commits.length, 1);
    assert.deepEqual([
      commits[0].calloutEnvelopes.length, commits[0].profileEnvelopes.length,
      commits[0].checkpointState.marker, commits[0].committedAt,
    ], [1, 1, 'event-1', '2026-08-25T15:00:00.000Z']);
    assert.deepEqual(persistence.getStatus(), {
      committedBatches: 1, bufferedCallouts: 0, bufferedProfiles: 0,
    });
  });

  it('serializes Fomo evidence and resumes its durable sequence', async () => {
    const commits = [];
    const repository = {
      loadCheckpoint: async () => ({ state: { sequence: 7 } }),
      commitCapture: async (input) => commits.push(input),
    };
    const persistence = createImmediateCalloutPersistence({ repository, checkpointKey: 'fomo:live', now: () => NOW });
    await Promise.all([
      persistence.eventSpool.append(envelope('callout', 'event-8')),
      persistence.identitySpool.append(envelope('profile', 'profile-9')),
    ]);

    assert.deepEqual(commits.map((commit) => commit.checkpointState.sequence), [8, 9]);
    assert.deepEqual([
      commits[0].calloutEnvelopes.length, commits[1].profileEnvelopes.length,
    ], [1, 1]);
  });

  it('keeps a failed Pump batch buffered until a later commit succeeds', async () => {
    let attempts = 0;
    const repository = {
      loadCheckpoint: async () => null,
      commitCapture: async () => { attempts += 1; if (attempts === 1) throw new Error('db unavailable'); },
    };
    const persistence = createPumpCalloutPersistence({ repository, checkpointKey: 'pump:live', now: () => NOW });
    await persistence.eventSpool.append(envelope('callout', 'event-retry'));
    await assert.rejects(persistence.stateStore.save({ marker: 'event-retry' }), /db unavailable/);
    assert.equal(persistence.getStatus().bufferedCallouts, 1);
    await persistence.stateStore.save({ marker: 'event-retry' });
    assert.deepEqual([attempts, persistence.getStatus().bufferedCallouts], [2, 0]);
  });

  it('starts and stops isolated Pump and Fomo collectors with safe telemetry', async () => {
    const lifecycle = [];
    const fakeCollector = (name) => ({
      start: async () => lifecycle.push(`start:${name}`),
      stop: async () => lifecycle.push(`stop:${name}`),
      getStatus: () => ({ running: true, secret: undefined }),
    });
    const repository = { loadCheckpoint: async () => null, commitCapture: async () => {} };
    const worker = createCalloutCaptureWorker({
      repository,
      createPumpClient: () => ({}),
      createPumpCollector: () => fakeCollector('pump'),
      createFomoCollector: () => fakeCollector('fomo'),
      createRetentionWorker: () => fakeCollector('retention'),
    });

    await worker.start({ pump: {}, fomo: {} });
    assert.deepEqual(lifecycle, ['start:retention', 'start:fomo', 'start:pump']);
    assert.equal(worker.getStatus().running, true);
    assert.deepEqual(worker.getStatus().retention, { running: true, secret: undefined });
    await worker.stop();
    assert.deepEqual(lifecycle, [
      'start:retention', 'start:fomo', 'start:pump',
      'stop:pump', 'stop:fomo', 'stop:retention',
    ]);
    assert.equal(worker.getStatus().running, false);
  });

  it('wires autonomous Fomo authentication without exposing its stores', async () => {
    let fomoOptions;
    const repository = { loadCheckpoint: async () => null, commitCapture: async () => {} };
    const worker = createCalloutCaptureWorker({
      repository,
      createPumpClient: () => ({}),
      createPumpCollector: () => ({ start: async () => {}, stop: async () => {} }),
      createFomoCollector: (options) => {
        fomoOptions = options;
        return { start: () => {}, stop: async () => {} };
      },
      createRetentionWorker: () => ({ start: () => {}, stop: async () => {} }),
      createFomoAuthentication: ({ jwtStore, refreshTokenStore }) => {
        assert.equal(typeof jwtStore.read, 'function');
        assert.equal(typeof refreshTokenStore.write, 'function');
        return { getJwt: async () => 'renewed.jwt.value', getStatus: () => ({ refreshes: 2 }) };
      },
    });

    await worker.start({
      pump: {},
      fomo: { jwtFile: '/state/customer-token', privyRefreshTokenFile: '/state/refresh-token' },
    });
    assert.equal(await fomoOptions.authenticationJwtProvider(), 'renewed.jwt.value');
    assert.deepEqual(worker.getStatus().fomoAuthentication, { refreshes: 2 });
    assert.equal(JSON.stringify(worker.getStatus()).includes('/state/'), false);
    await worker.stop();
  });

  it('uses browser CDP transport without autonomous JWT refresh or reconciliation', async () => {
    let fomoOptions;
    let authenticationCreations = 0;
    const repository = { loadCheckpoint: async () => null, commitCapture: async () => {} };
    const browserStream = () => ({ start: () => {}, stop: async () => {} });
    const worker = createCalloutCaptureWorker({
      repository,
      createPumpClient: () => ({}),
      createPumpCollector: () => ({ start: async () => {}, stop: async () => {} }),
      createFomoCollector: (options) => {
        fomoOptions = options;
        return { start: () => {}, stop: async () => {} };
      },
      createFomoBrowserStream: browserStream,
      createRetentionWorker: () => ({ start: () => {}, stop: async () => {} }),
      createFomoAuthentication: () => { authenticationCreations += 1; },
    });

    await worker.start({
      pump: {},
      fomo: {
        transport: 'browser_cdp', cdpEndpoint: 'http://127.0.0.1:9222',
        jwtFile: '/state/customer-token', privyRefreshTokenFile: '/state/refresh-token',
      },
    });
    assert.equal(authenticationCreations, 0);
    assert.equal(fomoOptions.streamFactory, browserStream);
    assert.deepEqual(fomoOptions.streamOptions, { cdpEndpoint: 'http://127.0.0.1:9222' });
    assert.equal(fomoOptions.reconciliationEnabled, false);
    assert.equal(fomoOptions.tradeLookupLimit, 0);
    await worker.stop();
  });

  it('starts the separately gated browser follow queue', async () => {
    let followOptions;
    let followStarted = 0;
    let followStopped = 0;
    const repository = { loadCheckpoint: async () => null, commitCapture: async () => {} };
    const worker = createCalloutCaptureWorker({
      repository,
      createPumpClient: () => ({}),
      createPumpCollector: () => ({ start: async () => {}, stop: async () => {} }),
      createFomoCollector: () => ({ start: () => {}, stop: async () => {} }),
      createFomoFollowQueue: (options) => {
        followOptions = options;
        return {
          start: () => { followStarted += 1; }, stop: async () => { followStopped += 1; },
          getStatus: () => ({ running: true }),
        };
      },
      createRetentionWorker: () => ({ start: () => {}, stop: async () => {} }),
    });

    await worker.start({
      pump: {}, fomo: {
        transport: 'browser_cdp', cdpEndpoint: 'http://127.0.0.1:9222',
        follow: { enabled: true, dryRun: true, profileIds: [FOMO_PROFILE] },
      },
    });
    assert.equal(followStarted, 1);
    assert.equal(followOptions.cdpEndpoint, 'http://127.0.0.1:9222');
    assert.deepEqual(worker.getStatus().fomoFollow, { running: true });
    await worker.stop();
    assert.equal(followStopped, 1);
  });
});
