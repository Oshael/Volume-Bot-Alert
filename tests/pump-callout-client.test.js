'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPumpCalloutClient } = require('../src/services/pump-callout-client');
const {
  normalizePumpActivity,
  normalizePumpProfile,
  sanitizePumpPayload,
} = require('../src/services/pump-callout-normalizer');

const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';

function response(body, options = {}) {
  return {
    ok: options.status ? options.status >= 200 && options.status < 300 : true,
    status: options.status || 200,
    headers: new Headers(options.headers || {}),
    text: async () => JSON.stringify(body),
  };
}

test('Pump client sends only the auth cookie and preserves pagination parameters', async () => {
  const requests = [];
  const client = createPumpCalloutClient({
    authToken: 'secret.jwt',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return response({ alerts: [] }, {
        headers: { 'x-ratelimit-remaining': '17', 'x-ratelimit-limit': '20' },
      });
    },
  });

  const result = await client.listFollowingAlerts({
    pageSize: 25,
    cursor: 'next cursor',
    kinds: ['callout', 'trade'],
    minTradeAmountUsd: 42,
  });

  const url = new URL(requests[0].url);
  assert.equal(requests[0].options.headers.cookie, 'auth_token=secret.jwt');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(url.pathname, '/following-positions/alerts');
  assert.equal(url.searchParams.get('pageSize'), '25');
  assert.equal(url.searchParams.get('cursor'), 'next cursor');
  assert.equal(url.searchParams.get('kinds'), 'callout,trade');
  assert.equal(result.rateLimit.remaining, 17);
  assert.equal(result.rateLimit.resetAt, null);
});

test('Pump client errors never expose the JWT or echoed response body', async () => {
  const token = 'sensitive.jwt.value';
  const client = createPumpCalloutClient({
    authToken: token,
    fetchImpl: async () => response({ auth_token: token }, {
      status: 429,
      headers: { 'retry-after': '3' },
    }),
  });

  await assert.rejects(client.getLeaderboard(), (error) => {
    assert.equal(error.code, 'PUMP_RATE_LIMIT');
    assert.equal(error.retryAfterMs, 3000);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  const unauthorized = createPumpCalloutClient({
    authToken: token,
    fetchImpl: async () => response({}, { status: 401 }),
  });
  await assert.rejects(unauthorized.getLeaderboard(), (error) => error.code === 'PUMP_AUTH');
});

test('Pump client rereads a token provider and classifies unavailable credentials as auth', async () => {
  const cookies = [];
  let token = 'first';
  const client = createPumpCalloutClient({
    authTokenProvider: async () => token,
    fetchImpl: async (_url, options) => {
      cookies.push(options.headers.cookie);
      return response({ callouts: [] });
    },
  });
  await client.getLeaderboard();
  token = 'second';
  await client.getLeaderboard();
  assert.deepEqual(cookies, ['auth_token=first', 'auth_token=second']);

  const unavailable = createPumpCalloutClient({ authTokenProvider: async () => '' });
  await assert.rejects(unavailable.getLeaderboard(), (error) => error.code === 'PUMP_AUTH');
});

test('Pump user profile lookup is public and never sends the auth cookie', async () => {
  const requests = [];
  const client = createPumpCalloutClient({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return response({ username: 'caller', profile_image: 'https://example.test/avatar.png' });
    },
  });

  const result = await client.getUserProfile('wallet/address');
  assert.equal(new URL(requests[0].url).pathname, '/users/wallet%2Faddress');
  assert.equal(requests[0].options.headers.cookie, undefined);
  assert.equal(result.body.username, 'caller');
});

test('profile normalization preserves profile to wallet observations without guessing chain', () => {
  const profile = normalizePumpProfile({
    userId: 'user-1',
    userName: 'caller',
    xUsername: 'caller_x',
    profileImage: 'https://example.test/profile.png',
    primaryWallet: 'PrimaryWallet',
    chainId: 'solana',
    wallets: [
      { address: 'PrimaryWallet', chainId: 'solana' },
      { walletAddress: '0xabc', chainId: 'robinhood' },
    ],
  });

  assert.equal(profile.platformUserId, 'user-1');
  assert.equal(profile.xUsername, 'caller_x');
  assert.equal(profile.profilePictureUrl, 'https://example.test/profile.png');
  assert.deepEqual(profile.wallets, [
    { address: 'PrimaryWallet', rawChainId: 'solana', sourceField: 'primaryWallet' },
    { address: '0xabc', rawChainId: 'robinhood', sourceField: null },
  ]);
});

test('profile API aliases enrich the existing callout identity and infer a Solana wallet', () => {
  const profile = normalizePumpProfile({
    platformUserId: 'callout-identity', userId: 'different-api-id', address: SOLANA,
    username: 'caller', x_username: 'caller_x', profile_image: 'https://example.test/avatar.png',
  });

  assert.equal(profile.platformUserId, 'callout-identity');
  assert.equal(profile.username, 'caller');
  assert.equal(profile.xUsername, 'caller_x');
  assert.equal(profile.profilePictureUrl, 'https://example.test/avatar.png');
  assert.deepEqual(profile.wallets, [
    { address: SOLANA, rawChainId: 'solana', sourceField: 'address' },
  ]);
});

test('activity normalization keeps thesis and distinguishes platform evidence', () => {
  const event = normalizePumpActivity({
    kind: 'callout',
    userId: 'user-1',
    walletAddress: 'Wallet1',
    coinMint: 'Mint1',
    chainId: 'solana',
    auth_token: 'must-not-survive',
    callout: {
      calloutId: 'call-1',
      thesis: 'Liquidity is growing',
      calledOutAtMcap: 125000,
      calloutTimestamp: '2026-08-24T12:00:00.000Z',
    },
  });

  assert.equal(event.sourceEventId, 'call-1');
  assert.equal(event.eventKind, 'callout');
  assert.equal(event.thesis, 'Liquidity is growing');
  assert.equal(event.marketCap, 125000);
  assert.equal(event.amount, null);
  assert.equal(event.amountUsd, null);
  assert.equal(event.calloutPrice, null);
  assert.equal(event.rawPayload.auth_token, undefined);
  assert.equal(normalizePumpActivity({ calloutId: 'epoch', userId: 'u', coinMint: 'm', thesis: 't', createdAt: 1787622930460 })
    .sourceCreatedAt, '2026-08-25T01:55:30.460Z');
});

test('payload sanitization redacts nested session material but preserves token data', () => {
  assert.deepEqual(sanitizePumpPayload({
    authorization: 'Bearer secret',
    nested: { cookie: 'auth_token=secret', csrfToken: 'secret', coinMint: 'Mint1' },
    token: { symbol: 'COIN' },
  }), {
    nested: { coinMint: 'Mint1' },
    token: { symbol: 'COIN' },
  });
});
