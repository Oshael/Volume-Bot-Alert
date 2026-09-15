'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  runFomoProfileSearchBatch,
} = require('../src/services/fomo-profile-search-discovery');

function fakePersistence(input = {}) {
  const persisted = [];
  const seedCalls = [];
  return {
    persisted,
    seedCalls,
    adapter: {
      loadSearchState: async () => input.state || {},
      listSearchSeeds: async (query) => {
        seedCalls.push(query);
        return typeof input.seeds === 'function' ? input.seeds(query) : (input.seeds || []);
      },
      persistSearch: async (users, state) => {
        persisted.push({ users, state });
        return { profiles: users.length, wallets: users.length * 2 };
      },
    },
  };
}

test('Fomo profile search advances its cursor atomically and deduplicates returned users', async () => {
  const persistence = fakePersistence({ seeds: [
    { platform_user_id: 'profile-a', username: 'Alpha One' },
    { platform_user_id: 'profile-b', username: 'Beta' },
  ] });
  const waits = [];
  const requests = [];
  const result = await runFomoProfileSearchBatch({
    persistence: persistence.adapter,
    batchSize: 20,
    now: () => Date.parse('2026-09-15T12:00:00.000Z'),
    wait: async (ms) => waits.push(ms),
    request: async (path) => {
      requests.push(path);
      return { status: 200, body: { responseObject: { users: [
        { id: 'nearby', userHandle: 'Nearby' },
      ] } } };
    },
  });

  assert.deepEqual(requests, [
    '/v2/users/fuzzy-search?searchTerm=Alpha%20One',
    '/v2/users/fuzzy-search?searchTerm=Beta',
  ]);
  assert.deepEqual(waits, [1_000]);
  assert.equal(result.complete, true);
  assert.equal(result.processedTerms, 2);
  assert.equal(result.returnedProfiles, 2);
  assert.equal(result.uniqueProfiles, 1);
  assert.equal(result.cursor, null);
  assert.equal(result.rounds, 1);
  assert.equal(persistence.persisted[0].users.length, 1);
  assert.equal(persistence.persisted[0].state.cursor, null);
});

test('Fomo profile search stops on rate limit and retries from the failed seed after backoff', async () => {
  const persistence = fakePersistence({
    state: { cursor: 'profile-before', rounds: 3 },
    seeds: [
      { platform_user_id: 'profile-a', username: 'Alpha' },
      { platform_user_id: 'profile-b', username: 'Beta' },
      { platform_user_id: 'profile-c', username: 'Gamma' },
    ],
  });
  let calls = 0;
  const result = await runFomoProfileSearchBatch({
    persistence: persistence.adapter,
    batchSize: 3,
    backoffMs: 60_000,
    now: () => Date.parse('2026-09-15T12:00:00.000Z'),
    wait: async () => {},
    request: async () => {
      calls += 1;
      if (calls === 2) return { status: 429, body: {} };
      return { status: 200, body: { responseObject: { users: [{ id: 'found-a' }] } } };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.complete, false);
  assert.equal(result.cursor, 'profile-a');
  assert.equal(result.lastHttpStatus, 429);
  assert.equal(result.lastErrorCode, 'FOMO_PROFILE_SEARCH_HTTP_429');
  assert.equal(result.nextAttemptAt, '2026-09-15T12:01:00.000Z');
  assert.equal(persistence.persisted[0].users[0].id, 'found-a');
});

test('Fomo profile search honors persisted backoff without reading or writing a batch', async () => {
  const persistence = fakePersistence({
    state: { nextAttemptAt: '2026-09-15T12:01:00.000Z' },
  });
  const result = await runFomoProfileSearchBatch({
    persistence: persistence.adapter,
    now: () => Date.parse('2026-09-15T12:00:00.000Z'),
    request: async () => assert.fail('request must not run during backoff'),
  });

  assert.deepEqual(result, {
    skipped: true, reason: 'backoff', nextAttemptAt: '2026-09-15T12:01:00.000Z',
  });
  assert.deepEqual(persistence.seedCalls, []);
  assert.deepEqual(persistence.persisted, []);
});
