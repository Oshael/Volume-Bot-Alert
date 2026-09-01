'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFomoPublicClient } = require('../src/services/fomo-public-client');
const {
  normalizeFomoActivityProfile,
  normalizeFomoLeaderboardProfile,
  normalizeFomoTradeIdentity,
} = require('../src/services/fomo-identity-normalizer');
const { normalizeFomoActivityItem } = require('../src/services/fomo-frame-normalizer');

const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const EVM = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('Fomo public client matches measured read-only endpoints without auth material', async () => {
  const requests = [];
  const client = createFomoPublicClient({
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return response({ success: true, responseObject: {} });
    },
  });

  await client.getLeaderboard('24h', { limit: 500 });
  await client.getTradingActivity({ limit: 25, threshold: 2000 });
  await client.getTrade('trade id');

  assert.deepEqual(requests.map(({ url }) => `${url.pathname}${url.search}`), [
    '/v2/leaderboard/24h?limit=100',
    '/feed/tradingActivity?limit=25&threshold=2000',
    '/trades/trade%20id',
  ]);
  for (const request of requests) {
    assert.deepEqual(request.options.headers, {
      accept: 'application/json',
      'x-supported-chains': '1,56,143,4663,8453,1399811149',
    });
    assert.equal(request.options.headers.authorization, undefined);
    assert.equal(request.options.headers.cookie, undefined);
  }
  assert.throws(() => client.getLeaderboard('1h'), /period must be/);
});

test('Fomo public client classifies HTTP errors without echoing response payloads', async () => {
  const client = createFomoPublicClient({
    fetchImpl: async () => response({ jwt: 'must-not-appear' }, 429),
  });
  await assert.rejects(client.getLeaderboard(), (error) => {
    assert.equal(error.code, 'FOMO_RATE_LIMIT');
    assert.equal(error.status, 429);
    assert.equal(error.message.includes('must-not-appear'), false);
    return true;
  });
});

test('Fomo leaderboard profile preserves reported Solana and chain-agnostic EVM wallets', () => {
  const profile = normalizeFomoLeaderboardProfile({
    id: 'profile-1',
    userHandle: 'caller',
    displayName: 'Caller',
    address: SOLANA,
    evmAddress: EVM,
  }, { observedAt: '2026-08-25T02:00:00.000Z', source: 'leaderboard:24h' });

  assert.equal(profile.source, 'leaderboard:24h');
  assert.equal(profile.wallets.length, 2);
  assert.deepEqual(profile.wallets[0], {
    addressOriginal: SOLANA,
    address: SOLANA,
    rawChainId: 'solana',
    chainKey: 'solana',
    chainFamily: 'solana',
    resolutionStatus: 'resolved',
    relationType: 'profile_wallet',
    sourceType: 'platform_reported',
    sourceField: 'address',
    sourceRecordId: null,
    confidence: 'high',
    evidenceAt: null,
  });
  assert.equal(profile.wallets[1].address, EVM.toLowerCase());
  assert.equal(profile.wallets[1].chainFamily, 'evm');
  assert.equal(profile.wallets[1].chainKey, null);
  assert.equal(profile.wallets[1].resolutionStatus, 'unknown_chain');
  assert.equal(profile.wallets[1].sourceType, 'platform_reported');
  assert.equal(normalizeFomoLeaderboardProfile({ id: 'profile-2', evmAddress: 'bad' })
    .wallets[0].resolutionStatus, 'invalid_address');
});

test('Fomo trading activity exposes profile metadata without inventing a wallet', () => {
  const profile = normalizeFomoActivityProfile({
    userId: 'profile-1', userHandle: 'active-caller', displayName: 'Active Caller',
    profilePictureLink: 'https://img.test/active.png',
  }, { observedAt: '2026-08-25T02:00:00.000Z' });

  assert.equal(profile.platformUserId, 'profile-1');
  assert.equal(profile.username, 'active-caller');
  assert.equal(profile.profilePictureUrl, 'https://img.test/active.png');
  assert.equal(profile.source, 'trading_activity');
  assert.deepEqual(profile.wallets, []);
  assert.equal(normalizeFomoActivityProfile({}), null);
});

test('Fomo trade detail adds event-specific side-wallet evidence without replacing profile wallets', () => {
  const observation = normalizeFomoTradeIdentity({
    responseObject: {
      userId: 'profile-1',
      userHandle: 'caller',
      trade: {
        id: 'trade-1',
        userAddress: EVM,
        networkId: 4663,
        createdAt: '2026-08-25T01:50:00.000Z',
      },
    },
  }, { observedAt: '2026-08-25T02:00:00.000Z' });

  assert.equal(observation.source, 'trade_detail');
  assert.equal(observation.wallets[0].relationType, 'activity_wallet');
  assert.equal(observation.wallets[0].sourceType, 'activity_used');
  assert.equal(observation.wallets[0].sourceRecordId, 'trade-1');
  assert.equal(observation.wallets[0].chainKey, 'robinhood');
  assert.equal(observation.wallets[0].evidenceAt, '2026-08-25T01:50:00.000Z');
  assert.equal(normalizeFomoTradeIdentity({ responseObject: { userId: 'profile-1', trade: {} } }), null);
});

test('Fomo HTTP trading activity items reuse the measured thesis contract', () => {
  const callout = normalizeFomoActivityItem({
    type: 'thesis', id: 'callout-1', tradeId: 'trade-1', userId: 'profile-1',
    userHandle: 'caller', createdAt: '2026-08-25T01:50:00.000Z',
    comment: { comment: 'HTTP thesis' }, tokenAddress: SOLANA,
    networkId: 1399811149, ticker: 'TEST',
  });
  assert.equal(callout.platformEventId, 'callout-1');
  assert.equal(callout.tradeId, 'trade-1');
  assert.equal(callout.thesis.text, 'HTTP thesis');
});
