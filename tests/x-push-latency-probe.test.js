'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  graphqlOperation, isCreatePostUrl, isTimelinePollUrl, summarize,
} = require('../src/utils/x-push-latency-probe');

test('classifies the publisher acknowledgement without treating it as polling', () => {
  const url = 'https://x.com/i/api/graphql/abc/CreateTweet';
  assert.equal(graphqlOperation(url), 'CreateTweet');
  assert.equal(isCreatePostUrl(url), true);
  assert.equal(isTimelinePollUrl(url), false);
});

test('detects X timeline reads but ignores unrelated GraphQL operations', () => {
  assert.equal(isTimelinePollUrl('https://x.com/i/api/graphql/q/ListLatestTweetsTimeline?variables=x'), true);
  assert.equal(isTimelinePollUrl('https://x.com/i/api/graphql/q/NotificationsTimeline'), true);
  assert.equal(isTimelinePollUrl('https://x.com/i/api/graphql/q/Viewer'), false);
});

test('summarizes the 200ms gate and fails closed on a missing push', () => {
  const passing = summarize([{ latencyMs: 120 }, { latencyMs: 200 }], 200);
  assert.deepEqual(passing, {
    published: 2,
    rejected: 0,
    matched: 2,
    missed: 0,
    targetMs: 200,
    p50Ms: 120,
    p95Ms: 200,
    maxMs: 200,
    withinTarget: 2,
    verdict: 'pass',
  });

  const failing = summarize([{ latencyMs: 80 }, { latencyMs: null }], 200);
  assert.equal(failing.missed, 1);
  assert.equal(failing.verdict, 'fail');
});
