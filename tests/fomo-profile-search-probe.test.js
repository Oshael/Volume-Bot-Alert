'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSearchTerms, readConfig, runFomoProfileSearchProbe,
} = require('../src/utils/fomo-profile-search-probe');

test('Fomo profile search probe builds bounded case-insensitive terms', () => {
  const profiles = [
    { username: ' Alpha ' }, { username: 'alpha' }, { username: '' },
    { username: 'Beta' }, { username: 'Gamma' },
  ];
  assert.deepEqual(buildSearchTerms(profiles, 2), ['Alpha', 'Beta']);
});

test('Fomo profile search probe measures unique discovery without persisting identities', async () => {
  const waits = [];
  const responses = {
    Alpha: [
      { id: 'known-a', userHandle: 'Alpha', address: 'solana-a' },
      { id: 'new-a', userHandle: 'Nearby', evmAddress: '0xabc' },
    ],
    Beta: [
      { id: 'new-a', userHandle: 'Nearby', evmAddress: '0xabc' },
      { id: 'new-b', userHandle: 'Another' },
    ],
  };
  const report = await runFomoProfileSearchProbe({
    profiles: [
      { platform_user_id: 'known-a', username: 'Alpha' },
      { platform_user_id: 'known-b', username: 'Beta' },
    ],
    termLimit: 100,
    delayMs: 250,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    request: async (path) => {
      const term = decodeURIComponent(new URL(path, 'https://fomo.test').searchParams.get('searchTerm'));
      return { status: 200, body: { responseObject: { users: responses[term] } } };
    },
  });

  assert.equal(report.complete, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.testedTerms, 2);
  assert.equal(report.results.returned, 4);
  assert.equal(report.results.unique, 3);
  assert.equal(report.results.repeated, 1);
  assert.equal(report.results.alreadyKnown, 1);
  assert.equal(report.results.newProfiles, 2);
  assert.equal(report.results.observedMaxPerTerm, 2);
  assert.deepEqual(report.walletCoverage, {
    withAnyWallet: 2, withSolana: 1, withEvm: 1, withoutWallet: 1,
  });
  assert.deepEqual(waits, [250]);
});

test('Fomo profile search probe records HTTP and request failures then continues', async () => {
  let calls = 0;
  const report = await runFomoProfileSearchProbe({
    profiles: [
      { platform_user_id: 'a', username: 'Alpha' },
      { platform_user_id: 'b', username: 'Beta' },
      { platform_user_id: 'c', username: 'Gamma' },
    ],
    delayMs: 250,
    wait: async () => {},
    request: async () => {
      calls += 1;
      if (calls === 1) return { status: 429, body: {} };
      if (calls === 2) throw Object.assign(new Error('secret response'), { code: 'FOMO_NETWORK' });
      return { status: 200, body: { responseObject: { users: [] } } };
    },
  });

  assert.equal(calls, 3);
  assert.equal(report.complete, false);
  assert.equal(report.successfulTerms, 1);
  assert.equal(report.failedTerms, 2);
  assert.deepEqual(report.httpStatusCounts, { 200: 1, 429: 1 });
  assert.deepEqual(report.errorCounts, { http_429: 1, FOMO_NETWORK: 1 });
  assert.equal(JSON.stringify(report).includes('secret response'), false);
});

test('Fomo profile search probe reads bounded environment options', () => {
  const config = readConfig({
    FOMO_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9333',
    FOMO_FOLLOW_USER_ID: 'account-id',
    FOMO_PROFILE_SEARCH_PROBE_LIMIT: '500',
    FOMO_PROFILE_SEARCH_PROBE_DELAY_MS: '10',
    FOMO_FOLLOW_AUTH_WAIT_SECONDS: '400',
    FOMO_FOLLOW_REQUEST_TIMEOUT_SECONDS: '20',
  });
  assert.deepEqual(config, {
    cdpEndpoint: 'http://127.0.0.1:9333', currentUserId: 'account-id',
    termLimit: 100, delayMs: 250, authWaitMs: 300_000, requestTimeoutMs: 20_000,
  });
});
