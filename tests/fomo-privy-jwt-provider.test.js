'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createFomoPrivyJwtProvider,
} = require('../src/services/fomo-privy-jwt-provider');

const NOW = Date.parse('2026-08-25T15:00:00.000Z');

function jwt(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

function store(initial) {
  let value = initial;
  const writes = [];
  return {
    read: async () => value,
    write: async (next) => { value = next; writes.push(next); },
    writes,
  };
}

describe('Fomo Privy customer token provider', () => {
  it('uses a current customer JWT without contacting Privy', async () => {
    const current = jwt((NOW / 1000) + 600);
    const jwtStore = store(current);
    const provider = createFomoPrivyJwtProvider({
      jwtStore, refreshTokenStore: store('refresh-secret'), now: () => NOW,
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });

    assert.equal(await provider.getJwt(), current);
    assert.equal(provider.getStatus().tokenExpiresAt, '2026-08-25T15:10:00.000Z');
    assert.deepEqual(jwtStore.writes, []);
  });

  it('refreshes an expired JWT and persists rotated credentials', async () => {
    const expired = jwt((NOW / 1000) - 1);
    const renewed = jwt((NOW / 1000) + 3600);
    const jwtStore = store(expired);
    const refreshStore = store('old-refresh-secret');
    const requests = [];
    const provider = createFomoPrivyJwtProvider({
      jwtStore, refreshTokenStore: refreshStore, now: () => NOW,
      clientAnalyticsId: 'ca-test',
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return {
          ok: true, status: 200,
          json: async () => ({
            token: null,
            privy_access_token: renewed,
            refresh_token: 'new-refresh-secret',
            session_update_action: 'ignore',
          }),
        };
      },
    });

    assert.equal(await provider.getJwt(), renewed);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://auth.privy.io/api/v1/sessions');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.origin, 'https://fomo.family');
    assert.equal(requests[0].options.headers['privy-ca-id'], 'ca-test');
    assert.equal(requests[0].options.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(requests[0].options.body), { refresh_token: 'old-refresh-secret' });
    assert.deepEqual(jwtStore.writes, [renewed]);
    assert.deepEqual(refreshStore.writes, ['new-refresh-secret']);
    assert.deepEqual(provider.getStatus(), {
      refreshes: 1, failures: 0, lastRefreshAt: '2026-08-25T15:00:00.000Z',
      lastErrorCode: null, requiresReauth: false,
      tokenExpiresAt: '2026-08-25T16:00:00.000Z',
    });
  });

  it('never substitutes the unrelated token field for the Privy WebSocket credential', async () => {
    const unrelatedToken = jwt((NOW / 1000) + 3600);
    const jwtStore = store(jwt(1));
    const provider = createFomoPrivyJwtProvider({
      jwtStore, refreshTokenStore: store('refresh-secret'), now: () => NOW,
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ token: unrelatedToken, privy_access_token: null }),
      }),
    });

    await assert.rejects(provider.getJwt(),
      (error) => error.code === 'FOMO_PRIVY_SESSION_RESPONSE');
    assert.deepEqual(jwtStore.writes, []);
  });

  it('coalesces concurrent refreshes into one session request', async () => {
    const renewed = jwt((NOW / 1000) + 3600);
    let requests = 0;
    const provider = createFomoPrivyJwtProvider({
      jwtStore: store(jwt(1)), refreshTokenStore: store('refresh-secret'), now: () => NOW,
      fetchImpl: async () => {
        requests += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { ok: true, status: 200, json: async () => ({ privy_access_token: renewed }) };
      },
    });

    assert.deepEqual(await Promise.all([provider.getJwt(), provider.getJwt()]), [renewed, renewed]);
    assert.equal(requests, 1);
  });

  it('keeps a still-valid JWT when Privy ignores an early refresh', async () => {
    const current = jwt((NOW / 1000) + 10);
    const provider = createFomoPrivyJwtProvider({
      jwtStore: store(current), refreshTokenStore: store('refresh-secret'), now: () => NOW,
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ privy_access_token: null, session_update_action: 'ignore' }),
      }),
    });
    assert.equal(await provider.getJwt(), current);
    assert.equal(provider.getStatus().requiresReauth, false);
  });

  it('reports reauthentication without exposing either credential', async () => {
    const jwtSecret = jwt(1);
    const refreshSecret = 'private-refresh-value';
    const provider = createFomoPrivyJwtProvider({
      jwtStore: store(jwtSecret), refreshTokenStore: store(refreshSecret), now: () => NOW,
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ privy_access_token: null, session_update_action: 'ignore' }),
      }),
    });

    await assert.rejects(provider.getJwt(), (error) => {
      assert.equal(error.code, 'FOMO_PRIVY_REAUTH_REQUIRED');
      assert.equal(error.message.includes(jwtSecret), false);
      assert.equal(error.message.includes(refreshSecret), false);
      return true;
    });
    const serializedStatus = JSON.stringify(provider.getStatus());
    assert.equal(serializedStatus.includes(jwtSecret) || serializedStatus.includes(refreshSecret), false);
    assert.equal(provider.getStatus().requiresReauth, true);
  });

  it('recovers through Privy when the customer credential is unavailable', async () => {
    const refreshSecret = 'private-refresh-value';
    const renewed = jwt((NOW / 1000) + 3600);
    const jwtStore = store('not-a-customer-jwt');
    let requests = 0;
    const provider = createFomoPrivyJwtProvider({
      jwtStore, refreshTokenStore: store(refreshSecret), now: () => NOW,
      fetchImpl: async () => {
        requests += 1;
        return { ok: true, status: 200, json: async () => ({ privy_access_token: renewed }) };
      },
    });

    assert.equal(await provider.getJwt(), renewed);
    assert.equal(requests, 1);
    assert.deepEqual(jwtStore.writes, [renewed]);
  });
});
