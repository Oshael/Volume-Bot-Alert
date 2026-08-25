'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPumpLocalCollector } = require('../src/services/pump-local-collector');
const { createStateStore } = require('../src/utils/pump-continuous-capture');

const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';

function callout(id, userId = 'user-1', createdAt = '2026-08-25T02:00:00.000Z') {
  return {
    calloutId: id, userId, coinMint: SOLANA, thesis: `thesis ${id}`,
    createdAt, walletAddress: SOLANA, chainId: 'solana',
  };
}

test('Pump collector persists cumulative watchlist/cursors and skips replay after restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pump-capture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateStore = createStateStore(path.join(directory, 'state.json'));
  const events = [];
  const identities = [];
  const userPageTokens = [];
  const client = {
    getLeaderboard: async () => ({ body: { callouts: [{
      userId: 'user-1', primaryWallet: SOLANA, wallets: [{ address: SOLANA }],
    }] } }),
    listFollowingAlerts: async () => ({ body: {
      items: [{ kind: 'callout', author: { userId: 'user-1', userName: 'caller' },
        walletAddress: SOLANA, chainId: 'solana', coinMint: SOLANA, callout: callout('call-1') }],
      nextCursor: 'cursor-2',
    } }),
    listUserCallouts: async (_userId, options) => {
      userPageTokens.push(options.pageToken);
      return options.pageToken === 'page-2'
        ? { body: { callouts: [callout('call-1')] } }
        : { body: { callouts: [callout('call-2', 'user-1', '2026-08-25T01:00:00.000Z')], nextPageToken: 'page-2' } };
    },
  };
  const options = {
    client, stateStore,
    eventSpool: { append: async (record) => events.push(record) },
    identitySpool: { append: async (record) => identities.push(record) },
    now: () => Date.parse('2026-08-25T02:05:00.000Z'),
    usersPerRound: 1,
  };

  const firstCollector = createPumpLocalCollector(options);
  await firstCollector.runOnce();
  assert.deepEqual(events.map((record) => record.payload.platformEventId), ['call-1', 'call-2']);
  assert.equal(firstCollector.getStatus().lastEventAt, '2026-08-25T02:00:00.000Z');
  assert.equal(identities.length, 3);
  assert.equal(identities[1].payload.wallets[0].sourceType, 'activity_used');
  const saved = await stateStore.load();
  assert.deepEqual(saved.watchlist, ['user-1']);
  assert.equal(saved.markers['user-1'], 'call-2');
  assert.equal(saved.followingCursor, 'cursor-2');
  assert.deepEqual(userPageTokens, [null, 'page-2']);

  await createPumpLocalCollector(options).runOnce();
  assert.equal(events.length, 2);
  assert.deepEqual(userPageTokens, [null, 'page-2', null]);
  assert.deepEqual((await stateStore.load()).watchlist, ['user-1']);
});

test('Pump collector pauses on auth and honors rate-limit retry delay', async () => {
  const base = {
    eventSpool: { append: async () => {} }, identitySpool: { append: async () => {} },
    stateStore: { load: async () => ({}), save: async () => {} },
    cancelSchedule: () => {},
  };
  const authSchedules = [];
  const auth = createPumpLocalCollector({
    ...base,
    client: {
      getLeaderboard: async () => { throw Object.assign(new Error('auth'), { code: 'PUMP_AUTH' }); },
      listFollowingAlerts: async () => ({ body: { items: [] } }),
    },
    schedule: (_callback, delay) => authSchedules.push(delay),
  });
  await auth.start();
  assert.equal(auth.getStatus().paused, true);
  assert.deepEqual(authSchedules, []);

  const rateSchedules = [];
  const rate = createPumpLocalCollector({
    ...base,
    client: {
      getLeaderboard: async () => { throw Object.assign(new Error('rate'), { code: 'PUMP_RATE_LIMIT', retryAfterMs: 3000 }); },
      listFollowingAlerts: async () => ({ body: { items: [] } }),
    },
    schedule: (_callback, delay) => { rateSchedules.push(delay); return 1; },
  });
  await rate.start();
  assert.equal(rate.getStatus().paused, false);
  assert.deepEqual(rateSchedules, [3000]);
  rate.stop();
});
