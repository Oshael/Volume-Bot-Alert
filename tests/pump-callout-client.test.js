'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPumpCalloutClient } = require('../src/services/pump-callout-client');
const {
  normalizePumpActivity,
  normalizePumpProfile,
  sanitizePumpPayload,
} = require('../src/services/pump-callout-normalizer');

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
});

test('profile normalization preserves profile to wallet observations without guessing chain', () => {
  const profile = normalizePumpProfile({
    userId: 'user-1',
    userName: 'caller',
    xUsername: 'caller_x',
    primaryWallet: 'PrimaryWallet',
    chainId: 'solana',
    wallets: [
      { address: 'PrimaryWallet', chainId: 'solana' },
      { walletAddress: '0xabc', chainId: 'robinhood' },
    ],
  });

  assert.equal(profile.platformUserId, 'user-1');
  assert.deepEqual(profile.wallets, [
    { address: 'PrimaryWallet', rawChainId: 'solana', sourceField: 'primaryWallet' },
    { address: '0xabc', rawChainId: 'robinhood', sourceField: null },
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
