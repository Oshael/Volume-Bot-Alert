'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CHECKPOINT_KEY, createFomoProfileDiscoveryPersistence,
} = require('../src/services/fomo-profile-discovery-persistence');

test('Fomo leaderboard persistence stores profile metadata and platform-reported wallets', async () => {
  const commits = [];
  const persistence = createFomoProfileDiscoveryPersistence({
    repository: { commitCapture: async (input) => commits.push(input) },
    now: () => Date.parse('2026-08-27T12:00:00.000Z'),
  });
  const profile = {
    id: '00000000-0000-4000-8000-00000000000a',
    userHandle: 'caller', displayName: 'Caller', profilePictureLink: 'https://img.test/a.png',
    address: '6ismWYLTwvzngqAzeWLhAfq1jSY2yv8hG55te1HnTw9j',
    evmAddress: '0x1111111111111111111111111111111111111111',
  };

  const result = await persistence.persist([
    { timeframe: '24h', profile }, { timeframe: '7d', profile },
  ]);

  assert.deepEqual(result, {
    profiles: 1, wallets: 2, persistedAt: '2026-08-27T12:00:00.000Z',
  });
  assert.equal(commits[0].checkpointKey, CHECKPOINT_KEY);
  assert.deepEqual(commits[0].checkpointState.timeframes, ['24h', '7d']);
  assert.equal(commits[0].profileEnvelopes.length, 2);
  const observation = commits[0].profileEnvelopes[0].payload;
  assert.equal(observation.username, 'caller');
  assert.equal(observation.displayName, 'Caller');
  assert.equal(observation.profilePictureUrl, 'https://img.test/a.png');
  assert.equal(observation.wallets[0].relationType, 'profile_wallet');
  assert.equal(observation.wallets[0].sourceType, 'platform_reported');
  assert.equal(observation.wallets[0].chainKey, 'solana');
  assert.equal(observation.wallets[1].chainFamily, 'evm');
});

test('Fomo activity persistence stores active profiles and trade-backed wallet evidence', async () => {
  const commits = [];
  const walletQueries = [];
  const repository = {
    commitCapture: async (input) => commits.push(input),
    findProfilesWithoutWallet: async (platform, ids) => {
      walletQueries.push({ platform, ids });
      return [ids[1]];
    },
  };
  const persistence = createFomoProfileDiscoveryPersistence({
    repository, now: () => Date.parse('2026-08-27T12:00:00.000Z'),
  });

  assert.deepEqual(await persistence.findMissingWalletProfileIds(['profile-a', 'profile-b']),
    ['profile-b']);
  const result = await persistence.persist([], {
    activityItems: [{
      userId: 'profile-b', userHandle: 'active', displayName: 'Active',
      profilePictureLink: 'https://img.test/active.png', tradeId: 'trade-b',
    }],
    tradeDetails: [{
      tradeId: 'trade-b', body: { responseObject: {
        userId: 'profile-b', userHandle: 'active',
        trade: {
          id: 'trade-b', userAddress: '0x1111111111111111111111111111111111111111',
          networkId: 4663, createdAt: '2026-08-27T11:59:00.000Z',
        },
      } },
    }],
  });

  assert.deepEqual(walletQueries, [{
    platform: 'fomo', ids: ['profile-a', 'profile-b'],
  }]);
  assert.deepEqual(result, {
    profiles: 1, wallets: 1, persistedAt: '2026-08-27T12:00:00.000Z',
  });
  assert.equal(commits[0].profileEnvelopes.length, 2);
  assert.equal(commits[0].profileEnvelopes[0].payload.profilePictureUrl,
    'https://img.test/active.png');
  assert.equal(commits[0].profileEnvelopes[1].payload.wallets[0].relationType,
    'activity_wallet');
  assert.equal(commits[0].checkpointState.activityProfiles, 1);
  assert.equal(commits[0].checkpointState.activityTradeIdentities, 1);
});
