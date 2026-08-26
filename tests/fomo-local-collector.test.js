'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFomoLocalCollector } = require('../src/services/fomo-local-collector');

const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const EVM = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';

function thesis(id = 'callout-1') {
  return {
    type: 'thesis', id, tradeId: 'trade-1', userId: 'profile-1', userHandle: 'caller',
    displayName: 'Caller', createdAt: '2026-08-25T01:50:00.000Z',
    comment: { comment: 'Accumulating thesis' }, tokenAddress: SOLANA,
    networkId: 1399811149, ticker: 'TEST',
  };
}

test('Fomo local collector reconciles identities/theses and deduplicates the live replay', async () => {
  const events = [];
  const identities = [];
  const schedules = [];
  let streamOptions;
  let streamStarted = false;
  const publicClient = {
    getLeaderboard: async () => ({ body: { responseObject: { leaderboard: [{
      id: 'profile-1', userHandle: 'caller', displayName: 'Caller', address: SOLANA, evmAddress: EVM,
    }] } } }),
    getTradingActivity: async () => ({ body: { responseObject: { items: [thesis()] } } }),
    getTrade: async () => ({ body: { responseObject: {
      userId: 'profile-1', userHandle: 'caller', trade: {
        id: 'trade-1', userAddress: EVM, networkId: 4663, createdAt: '2026-08-25T01:49:00.000Z',
      },
    } } }),
  };
  const collector = createFomoLocalCollector({
    publicClient,
    eventSpool: { append: async (record) => events.push(record) },
    identitySpool: { append: async (record) => identities.push(record) },
    topicId: 'ea1bc7f5-e349-5c6d-ab41-740c237a792d',
    headers: { Origin: 'https://fomo.family' },
    authenticationJwt: 'header.payload.signature',
    now: () => Date.parse('2026-08-25T02:00:00.000Z'),
    schedule: (callback, delayMs) => { schedules.push({ callback, delayMs }); return schedules.length; },
    cancelSchedule: () => {},
    streamFactory: (options) => {
      streamOptions = options;
      return {
        start: () => { streamStarted = true; }, stop: () => {},
        getStatus: () => ({ connected: streamStarted }),
      };
    },
  });

  collector.start();
  await collector.flush();

  assert.equal(streamStarted, true);
  assert.deepEqual(streamOptions.headers, { Origin: 'https://fomo.family' });
  assert.equal(schedules[0].delayMs, 15 * 60_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.thesis, 'Accumulating thesis');
  assert.equal(identities.length, 3);
  assert.deepEqual(identities.map((record) => record.payload.wallets.length), [2, 0, 1]);
  assert.equal(identities[2].payload.wallets[0].sourceType, 'activity_used');
  assert.equal(identities[2].payload.wallets[0].chainKey, 'robinhood');

  streamOptions.onEvidence({ eventType: 'challengeAccepted', callout: null });
  assert.equal(events.length, 1);
  assert.equal(collector.getStatus().errors, 0);

  streamOptions.onEvidence({ callout: require('../src/services/fomo-frame-normalizer').normalizeFomoActivityItem(thesis()) });
  await collector.flush();
  assert.equal(events.length, 1);
  assert.equal(collector.getStatus().duplicates, 1);
  assert.equal(collector.getStatus().wallets, 3);
  await collector.stop();
});

test('Fomo local collector can run browser live transport without direct HTTP reconciliation', async () => {
  let streamOptions;
  let directCalls = 0;
  const collector = createFomoLocalCollector({
    eventSpool: { append: async () => {} },
    identitySpool: { append: async () => {} },
    publicClient: {
      getLeaderboard: async () => { directCalls += 1; },
      getTradingActivity: async () => { directCalls += 1; },
      getTrade: async () => { directCalls += 1; },
    },
    reconciliationEnabled: false,
    lookupLiveTrades: false,
    tradeLookupLimit: 0,
    streamOptions: { cdpEndpoint: 'http://127.0.0.1:9222' },
    streamFactory: (options) => {
      streamOptions = options;
      return { start: () => {}, stop: async () => {}, getStatus: () => ({ running: true }) };
    },
  });

  collector.start();
  streamOptions.onEvidence({
    callout: require('../src/services/fomo-frame-normalizer').normalizeFomoActivityItem(thesis()),
  });
  await collector.flush();
  assert.equal(directCalls, 0);
  assert.equal(collector.getStatus().callouts, 1);
  assert.equal(collector.getStatus().errors, 0);
  assert.equal(streamOptions.cdpEndpoint, 'http://127.0.0.1:9222');
  await collector.stop();
});

test('Fomo reconciliation keeps activity when leaderboard discovery fails', async () => {
  const events = [];
  const collector = createFomoLocalCollector({
    eventSpool: { append: async (record) => events.push(record) },
    identitySpool: { append: async () => {} },
    topicId: 'ea1bc7f5-e349-5c6d-ab41-740c237a792d',
    publicClient: {
      getLeaderboard: async () => { throw Object.assign(new Error('failed'), { code: 'FOMO_HTTP' }); },
      getTradingActivity: async () => ({ body: { responseObject: { items: [thesis()] } } }),
      getTrade: async () => ({ body: {} }),
    },
    streamFactory: () => ({ start() {}, stop() {}, getStatus: () => ({}) }),
    schedule: () => 1,
    cancelSchedule: () => {},
  });

  collector.start();
  await collector.flush();
  assert.equal(events.length, 1);
  assert.equal(collector.getStatus().errors, 1);
  await collector.stop();
});
