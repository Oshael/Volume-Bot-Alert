'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHeaders, parseRateLimit, extractNewCt0, callGraphql, dispatcherFor,
} = require('../src/services/x-graphql-client');

function headers(map = {}, setCookie = []) {
  const lower = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null), getSetCookie: () => setCookie };
}

test('buildHeaders sets csrf to ct0 and carries both cookies', () => {
  const h = buildHeaders({ authToken: 'AUTH', ct0: 'CT0' });
  assert.equal(h['x-csrf-token'], 'CT0');
  assert.match(h.cookie, /auth_token=AUTH/);
  assert.match(h.cookie, /ct0=CT0/);
  assert.equal(h['x-twitter-auth-type'], 'OAuth2Session');
});

test('parseRateLimit converts reset seconds to ms and null when absent', () => {
  assert.deepEqual(
    parseRateLimit(headers({ 'x-rate-limit-limit': '500', 'x-rate-limit-remaining': '499', 'x-rate-limit-reset': '1000' })),
    { limit: 500, remaining: 499, resetMs: 1000000 },
  );
  assert.equal(parseRateLimit(headers({})), null);
});

test('extractNewCt0 returns a rotated ct0 only when it changed', () => {
  assert.equal(extractNewCt0(headers({}, ['ct0=NEW; Path=/; Secure']), 'OLD'), 'NEW');
  assert.equal(extractNewCt0(headers({}, ['ct0=SAME; Path=/']), 'SAME'), null);
  assert.equal(extractNewCt0(headers({}, ['other=x; Path=/']), 'OLD'), null);
});

test('dispatcherFor is null in the alpha (no proxy)', () => {
  assert.equal(dispatcherFor(null), null);
  assert.equal(dispatcherFor('http://proxy:8080'), null); // deferred seam
});

test('callGraphql returns body, rate limit and rotated ct0 from the response', async () => {
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      status: 200,
      headers: headers({ 'x-rate-limit-remaining': '499', 'x-rate-limit-reset': '1000' }, ['ct0=ROTATED; Path=/']),
      json: async () => ({ data: { ok: 1 } }),
    };
  };
  const result = await callGraphql({
    session: { authToken: 'a', ct0: 'OLD' },
    queryId: 'QID', operationName: 'ListLatestTweetsTimeline',
    variables: { listId: '9' }, features: {}, fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.data.ok, 1);
  assert.equal(result.newCt0, 'ROTATED');
  assert.equal(result.rateLimit.remaining, 499);
  assert.match(calledUrl, /graphql\/QID\/ListLatestTweetsTimeline/);
});
