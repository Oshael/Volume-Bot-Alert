'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createFomoBrowserApi,
  createFomoBrowserFollowQueue,
  leaderboardProfileIds,
  normalizeProfileIds,
} = require('../src/services/fomo-browser-follow-queue');

const USER = '00000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function ok(responseObject) {
  return { status: 200, body: { statusCode: 200, responseObject } };
}

function apiFixture({ following = [], followStatus = 200, leaderboard = [] } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      currentUserId: USER,
      async request(path, init) {
        calls.push({ path, init });
        if (path.startsWith('/v2/leaderboard/24h?')) return ok({ leaderboard });
        if (path === '/v2/users/current/followingIds') return ok({ followingIds: following });
        return { status: followStatus, body: { statusCode: followStatus } };
      },
      async close() {},
    },
  };
}

test('Fomo follow allowlist accepts unique UUIDs only', () => {
  assert.deepEqual(normalizeProfileIds([A, A, B]), [A, B]);
  assert.throws(() => normalizeProfileIds(['not-an-id']), /UUIDs/);
});

test('Fomo leaderboard discovery keeps eligible unique profiles in rank order', () => {
  assert.deepEqual(leaderboardProfileIds({ leaderboard: [
    { id: USER }, { id: A, private: true }, { id: B },
    { id: B }, { id: C, isRestricted: true }, { id: 'invalid' },
  ] }, USER, 10), [B]);
});

test('Fomo browser API reuses observed auth and detaches without closing Chrome', async () => {
  const cdp = new EventEmitter();
  let detached = 0;
  cdp.send = async (method) => {
    if (method === 'Network.getResponseBody') {
      return { body: JSON.stringify({ responseObject: { id: USER } }), base64Encoded: false };
    }
    return {};
  };
  cdp.detach = async () => { detached += 1; };
  let evaluation;
  const page = new EventEmitter();
  page.url = () => 'https://fomo.family/alerts';
  const context = { pages: () => [page], newCDPSession: async () => cdp };
  page.context = () => context;
  page.reload = async () => {
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'api-1', request: {
        url: 'https://prod-api.fomo.family/v2/users', method: 'POST',
        headers: { Authorization: 'Bearer fixture-token', 'X-Supported-Chains': 'solana' },
      },
    });
    cdp.emit('Network.loadingFinished', { requestId: 'api-1' });
  };
  page.evaluate = async (_callback, input) => { evaluation = input; return ok({}); };
  let browserClosed = 0;
  const browser = { contexts: () => [context], close: () => { browserClosed += 1; } };

  const api = await createFomoBrowserApi({ connectOverCDP: async () => browser });
  assert.equal(api.currentUserId, USER);
  await api.request('/follows', { method: 'POST', body: { following_id: A } });
  assert.equal(evaluation.requestPath, '/follows');
  assert.equal(evaluation.auth.authorization, 'Bearer fixture-token');
  assert.equal(evaluation.auth.supportedChains, 'solana');
  await api.close();
  assert.equal(detached, 1);
  assert.equal(browserClosed, 0);
});

test('Fomo browser API falls back to outbound WebSocket auth and account identity', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  cdp.detach = async () => {};
  let evaluation;
  const page = new EventEmitter();
  page.url = () => 'https://fomo.family/alerts';
  const context = { pages: () => [page], newCDPSession: async () => cdp };
  page.context = () => context;
  page.reload = async () => {
    cdp.emit('Network.webSocketFrameSent', {
      response: { payloadData: JSON.stringify({ type: 'challengeResponse', jwt: 'ws-token' }) },
    });
    cdp.emit('Network.webSocketFrameSent', {
      response: { payloadData: JSON.stringify({
        type: 'subscribe', topicType: 'trading_activity', topicId: USER,
      }) },
    });
  };
  page.evaluate = async (_callback, input) => { evaluation = input; return ok({}); };
  const browser = { contexts: () => [context] };

  const api = await createFomoBrowserApi({ connectOverCDP: async () => browser });
  await api.request('/v2/users/current/followingIds');
  assert.equal(api.currentUserId, USER);
  assert.equal(evaluation.auth.authorization, 'Bearer ws-token');
  assert.equal(evaluation.auth.supportedChains, undefined);
  await api.close();
});

test('Fomo follow queue plans a dry-run without writing to the account', async () => {
  const fixture = apiFixture({ following: [A] });
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: true, profileIds: [A, B],
    createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  assert.deepEqual(fixture.calls.map((call) => call.path), [
    '/v2/users/current/followingIds',
  ]);
  assert.equal(queue.getStatus().alreadyFollowed, 1);
  assert.equal(queue.getStatus().planned, 1);
  assert.equal(queue.getStatus().followed, 0);
});

test('Fomo follow queue discovers Top Profits candidates in dry-run without writes', async () => {
  const fixture = apiFixture({ following: [A], leaderboard: [{ id: A }, { id: B }, { id: C }] });
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: true, discoveryEnabled: true, discoveryLimit: 3,
    profileIds: [], createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  assert.deepEqual(fixture.calls.map((call) => call.path), [
    '/v2/leaderboard/24h?limit=3', '/v2/users/current/followingIds',
  ]);
  assert.equal(fixture.calls.some((call) => call.path === '/follows'), false);
  assert.deepEqual(queue.getStatus(), {
    enabled: true, dryRun: true, discoveryEnabled: true, running: false,
    discovered: 3, planned: 2, followed: 0, alreadyFollowed: 1,
    errors: 0, paused: false, lastErrorCode: null,
    completedAt: queue.getStatus().completedAt,
  });
});

test('Fomo live discovery writes only the highest-ranked pending candidate', async () => {
  const fixture = apiFixture({ following: [A], leaderboard: [{ id: A }, { id: B }, { id: C }] });
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, discoveryEnabled: true, discoveryLimit: 3,
    profileIds: [], maxFollowsPerRun: 1, wait: async () => {},
    createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  const writes = fixture.calls.filter((call) => call.path === '/follows');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].init.body, { user_id: USER, following_id: B });
  assert.equal(queue.getStatus().followed, 1);
});

test('Fomo follow queue writes one allowlisted follow sequentially and idempotently', async () => {
  const fixture = apiFixture({ following: [A] });
  const delays = [];
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A, B, C], maxFollowsPerRun: 1,
    delayMs: 5_000, random: () => 0.5,
    wait: async (delayMs) => { delays.push(delayMs); },
    createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  const write = fixture.calls.find((call) => call.path === '/follows');
  assert.deepEqual(delays, [5_000]);
  assert.deepEqual(write.init, {
    method: 'POST', body: { user_id: USER, following_id: B },
  });
  assert.equal(queue.getStatus().followed, 1);
  assert.equal(queue.getStatus().planned, 2);
});

test('Fomo follow queue pauses immediately when account writes receive 403', async () => {
  const fixture = apiFixture({ followStatus: 403 });
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A, B], maxFollowsPerRun: 10,
    wait: async () => {}, createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  assert.equal(fixture.calls.filter((call) => call.path === '/follows').length, 1);
  assert.equal(queue.getStatus().paused, true);
  assert.equal(queue.getStatus().lastErrorCode, 'FOMO_FOLLOW_HTTP_403');
});
