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

async function waitForCycles(queue, count) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = queue.getStatus();
    if (status.cycles >= count && !status.running) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Fomo follow queue did not complete ${count} cycles`);
}

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
        if (path.startsWith('/v2/leaderboard/')) return ok({ leaderboard });
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
  assert.equal(evaluation.timeoutMs, 15_000);
  await api.close();
  assert.equal(detached, 1);
  assert.equal(browserClosed, 0);
});

test('Fomo browser API falls back to outbound WebSocket auth and account identity', async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({});
  cdp.detach = async () => {};
  let evaluation;
  let evaluationError = null;
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
  page.evaluate = async (_callback, input) => {
    if (evaluationError) throw evaluationError;
    evaluation = input;
    return ok({});
  };
  const browser = { contexts: () => [context] };

  const api = await createFomoBrowserApi({ connectOverCDP: async () => browser });
  await api.request('/v2/users/current/followingIds');
  assert.equal(api.currentUserId, USER);
  assert.equal(evaluation.auth.authorization, 'Bearer ws-token');
  assert.equal(evaluation.auth.supportedChains, undefined);
  evaluationError = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  await assert.rejects(api.request('/follows'), (error) => (
    error.code === 'FOMO_FOLLOW_REQUEST_TIMEOUT'
  ));
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
    '/v2/leaderboard/24h?limit=3', '/v2/leaderboard/7d?limit=3',
    '/v2/leaderboard/30d?limit=3', '/v2/users/current/followingIds',
  ]);
  assert.equal(fixture.calls.some((call) => call.path === '/follows'), false);
  assert.deepEqual(queue.getStatus(), {
    enabled: true, followEnabled: true, dryRun: true, discoveryEnabled: true, running: false,
    discovered: 3, planned: 2, followed: 0, alreadyFollowed: 1,
    persistedProfiles: 0, persistedWallets: 0, lastDiscoveryPersistedAt: null,
    cycles: 1, intervalMs: 300_000, lastStartedAt: queue.getStatus().lastStartedAt,
    nextRunAt: null,
    errors: 0, paused: false, pausePersisted: false, pausedAt: null, lastErrorCode: null,
    alertSentAt: null, alertErrors: 0, lastAlertErrorCode: null,
    completedAt: queue.getStatus().completedAt,
  });
});

test('Fomo follow discovery covers the Top 100 by default', async () => {
  const fixture = apiFixture();
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: true, discoveryEnabled: true,
    profileIds: [], createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  assert.deepEqual(fixture.calls.slice(0, 3).map((call) => call.path), [
    '/v2/leaderboard/24h?limit=100', '/v2/leaderboard/7d?limit=100',
    '/v2/leaderboard/30d?limit=100',
  ]);
});

test('Fomo discovery skips an unavailable ranking without losing available profiles', async () => {
  const calls = [];
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: true, discoveryEnabled: true, discoveryLimit: 2,
    profileIds: [],
    createBrowserApi: async () => ({
      currentUserId: USER,
      async request(path) {
        calls.push(path);
        if (path.includes('/24h?')) return ok({ leaderboard: [{ id: A }] });
        if (path.startsWith('/v2/leaderboard/')) return { status: 404, body: { statusCode: 404 } };
        return ok({ followingIds: [] });
      },
      async close() {},
    }),
  });

  queue.start();
  await queue.stop();
  assert.equal(calls.includes('/v2/users/current/followingIds'), true);
  assert.equal(queue.getStatus().discovered, 1);
  assert.equal(queue.getStatus().planned, 1);
  assert.equal(queue.getStatus().paused, false);
});

test('Fomo follow queue keeps discovering and following on bounded recurring cycles', async () => {
  const following = new Set();
  const writes = [];
  const scheduled = [];
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, discoveryEnabled: true, discoveryLimit: 3,
    profileIds: [], maxFollowsPerRun: 1, intervalMs: 300_000,
    wait: async () => {}, now: () => Date.parse('2026-08-27T00:00:00.000Z'),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancelSchedule: () => {},
    createBrowserApi: async () => ({
      currentUserId: USER,
      async request(path, init) {
        if (path.startsWith('/v2/leaderboard/')) {
          return ok({ leaderboard: [{ id: A }, { id: B }, { id: C }] });
        }
        if (path === '/v2/users/current/followingIds') {
          return ok({ followingIds: [...following] });
        }
        writes.push(init.body.following_id);
        following.add(init.body.following_id);
        return ok({});
      },
      async close() {},
    }),
  });

  queue.start();
  await waitForCycles(queue, 1);
  assert.deepEqual(writes, [A]);
  assert.equal(scheduled[0].delayMs, 300_000);
  scheduled.shift().callback();
  await waitForCycles(queue, 2);
  assert.deepEqual(writes, [A, B]);
  assert.equal(queue.getStatus().nextRunAt, '2026-08-27T00:05:00.000Z');
  await queue.stop();
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

test('Fomo profile discovery persists rankings without reading or writing follows', async () => {
  const fixture = apiFixture({ leaderboard: [{ id: A }, { id: B }] });
  const persisted = [];
  const queue = createFomoBrowserFollowQueue({
    enabled: true, followEnabled: false, dryRun: true,
    discoveryEnabled: true, discoveryLimit: 2, profileIds: [],
    profilePersistence: { persist: async (entries) => {
      persisted.push(entries);
      return { profiles: 2, wallets: 3, persistedAt: '2026-08-27T12:00:00.000Z' };
    } },
    createBrowserApi: async () => fixture.api,
  });

  queue.start();
  await queue.stop();
  assert.deepEqual(fixture.calls.map((call) => call.path), [
    '/v2/leaderboard/24h?limit=2', '/v2/leaderboard/7d?limit=2',
    '/v2/leaderboard/30d?limit=2',
  ]);
  assert.equal(persisted[0].length, 6);
  assert.deepEqual([...new Set(persisted[0].map((entry) => entry.timeframe))], ['24h', '7d', '30d']);
  assert.equal(queue.getStatus().followEnabled, false);
  assert.equal(queue.getStatus().persistedProfiles, 2);
  assert.equal(queue.getStatus().persistedWallets, 3);
  assert.equal(queue.getStatus().planned, 0);
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

test('Fomo follow queue durably pauses immediately on any failed account write', async () => {
  const fixture = apiFixture({ followStatus: 500 });
  const saved = [];
  const scheduled = [];
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A, B], maxFollowsPerRun: 10,
    wait: async () => {}, createBrowserApi: async () => fixture.api,
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    stateStore: { load: async () => null, save: async (state) => saved.push(state) },
  });

  queue.start();
  await waitForCycles(queue, 1);
  await queue.stop();
  assert.equal(fixture.calls.filter((call) => call.path === '/follows').length, 1);
  assert.equal(queue.getStatus().paused, true);
  assert.equal(queue.getStatus().pausePersisted, true);
  assert.equal(queue.getStatus().lastErrorCode, 'FOMO_FOLLOW_HTTP_500');
  assert.equal(scheduled.length, 0);
  assert.deepEqual(saved[0], {
    paused: true, pausedAt: queue.getStatus().pausedAt,
    lastErrorCode: 'FOMO_FOLLOW_HTTP_500', alertSentAt: null,
  });
});

test('Fomo follow pause sends one alert and durably records its delivery', async () => {
  const fixture = apiFixture({ followStatus: 429 });
  const saved = [];
  const alerts = [];
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A], wait: async () => {},
    createBrowserApi: async () => fixture.api,
    stateStore: { load: async () => null, save: async (state) => saved.push(state) },
    pauseNotifier: { sendPauseAlert: async (event) => alerts.push(event) },
  });

  queue.start();
  await queue.stop();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].lastErrorCode, 'FOMO_FOLLOW_HTTP_429');
  assert.equal(saved.length, 2);
  assert.equal(saved[0].alertSentAt, null);
  assert.equal(saved[1].alertSentAt, queue.getStatus().alertSentAt);
  assert.equal(queue.getStatus().alertErrors, 0);
});

test('Fomo follow durable pause does not resend an acknowledged alert', async () => {
  let alertAttempts = 0;
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A],
    createBrowserApi: async () => { throw new Error('browser must not open'); },
    stateStore: { load: async () => ({
      paused: true, pausedAt: '2026-08-26T19:00:00.000Z',
      lastErrorCode: 'FOMO_FOLLOW_HTTP_429', alertSentAt: '2026-08-26T19:00:01.000Z',
    }), save: async () => {} },
    pauseNotifier: { sendPauseAlert: async () => { alertAttempts += 1; } },
  });

  queue.start();
  await queue.stop();
  assert.equal(alertAttempts, 0);
  assert.equal(queue.getStatus().alertSentAt, '2026-08-26T19:00:01.000Z');
});

test('Fomo follow retries an unacknowledged pause alert after restart', async () => {
  const saved = [];
  let alertAttempts = 0;
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A],
    createBrowserApi: async () => { throw new Error('browser must not open'); },
    stateStore: { load: async () => ({
      paused: true, pausedAt: '2026-08-26T19:00:00.000Z',
      lastErrorCode: 'FOMO_FOLLOW_HTTP_429', alertSentAt: null,
    }), save: async (state) => saved.push(state) },
    pauseNotifier: { sendPauseAlert: async () => { alertAttempts += 1; } },
  });

  queue.start();
  await queue.stop();
  assert.equal(alertAttempts, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].alertSentAt, queue.getStatus().alertSentAt);
});

test('Fomo follow keeps its durable pause when Telegram delivery fails', async () => {
  const saved = [];
  const timeout = Object.assign(new Error('timeout'), { code: 'FOMO_FOLLOW_AUTH_TIMEOUT' });
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A],
    createBrowserApi: async () => { throw timeout; },
    stateStore: { load: async () => null, save: async (state) => saved.push(state) },
    pauseNotifier: { sendPauseAlert: async () => {
      throw Object.assign(new Error('telegram down'), { code: 'telegram_timeout' });
    } },
  });

  queue.start();
  await queue.stop();
  assert.equal(queue.getStatus().paused, true);
  assert.equal(queue.getStatus().pausePersisted, true);
  assert.equal(queue.getStatus().alertErrors, 1);
  assert.equal(queue.getStatus().lastAlertErrorCode, 'telegram_timeout');
  assert.equal(saved.length, 1);
});

test('Fomo follow queue persists timeouts and does not attempt a write', async () => {
  const saved = [];
  const timeout = Object.assign(new Error('timeout'), { code: 'FOMO_FOLLOW_AUTH_TIMEOUT' });
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A],
    createBrowserApi: async () => { throw timeout; },
    stateStore: { load: async () => null, save: async (state) => saved.push(state) },
  });

  queue.start();
  await queue.stop();
  assert.equal(queue.getStatus().paused, true);
  assert.equal(queue.getStatus().lastErrorCode, 'FOMO_FOLLOW_AUTH_TIMEOUT');
  assert.equal(saved.length, 1);
});

test('Fomo follow queue honors a durable pause without opening the browser', async () => {
  let browserCreations = 0;
  const queue = createFomoBrowserFollowQueue({
    enabled: true, dryRun: false, profileIds: [A],
    createBrowserApi: async () => { browserCreations += 1; },
    stateStore: { load: async () => ({
      paused: true, pausedAt: '2026-08-26T18:00:00.000Z',
      lastErrorCode: 'FOMO_FOLLOW_HTTP_429',
    }), save: async () => {} },
  });

  queue.start();
  await queue.stop();
  assert.equal(browserCreations, 0);
  assert.equal(queue.getStatus().paused, true);
  assert.equal(queue.getStatus().pausePersisted, true);
  assert.equal(queue.getStatus().lastErrorCode, 'FOMO_FOLLOW_HTTP_429');
});
