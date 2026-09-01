'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCalloutWalletProfileReadRepository, __private,
} = require('../src/models/callout-wallet-profile-read');

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;

test('callout wallet profile read resolves Fomo and Pump EVM identities deterministically', async () => {
  const calls = [];
  const repository = createCalloutWalletProfileReadRepository({ database: {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{
        address_normalized: A, platform: 'fomo', platform_user_id: 'profile-a',
        username: 'caller', x_username: null, display_name: 'Caller',
        profile_picture_url: 'https://img.test/a.png',
      }, {
        address_normalized: B, platform: 'pump', platform_user_id: 'profile-b',
        username: 'pump-caller', x_username: 'pump-x', display_name: null,
        profile_picture_url: 'https://img.test/b.png',
      }] };
    },
  } });

  assert.deepEqual(await repository.findByWalletAddresses([A.toUpperCase(), B, B]), [{
    address: A, platform: 'fomo', platformUserId: 'profile-a', username: 'caller',
    xUsername: null, displayName: 'Caller', profilePictureUrl: 'https://img.test/a.png',
  }, {
    address: B, platform: 'pump', platformUserId: 'profile-b', username: 'pump-caller',
    xUsername: 'pump-x', displayName: null, profilePictureUrl: 'https://img.test/b.png',
  }]);
  assert.equal(calls[0].sql, __private.PROFILE_BY_EVM_WALLET_SQL);
  assert.deepEqual(calls[0].params, [[A, B]]);
  assert.match(calls[0].sql, /wallet\.platform IN \('fomo', 'pump'\)/);
  assert.match(calls[0].sql, /wallet\.chain_family = 'evm'/);
  assert.match(calls[0].sql, /DISTINCT ON \(wallet\.address_normalized\)/);
});

test('callout wallet profile read skips the database for an empty page', async () => {
  let queries = 0;
  const repository = createCalloutWalletProfileReadRepository({ database: {
    query: async () => { queries += 1; },
  } });
  assert.deepEqual(await repository.findByWalletAddresses([]), []);
  assert.equal(queries, 0);
});
