'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildScaleSummary, headRequestUrl, parsePushEvent,
} = require('../src/utils/x-push-scale-probe');

test('parsePushEvent keeps useful fields without leaking the FCM registration id', () => {
  const payload = {
    registration_ids: ['https://fcm.googleapis.com/fcm/send/secret'],
    title: 'Karma',
    body: 'a post',
    timestamp: '1787556582453',
    tag: 'tweet-2091790034084982879',
  };
  const parsed = parsePushEvent({
    service: 'pushMessaging',
    eventName: 'Push message received',
    eventMetadata: [{ key: 'Payload', value: JSON.stringify(payload) }],
  }, '2026-08-24T07:29:42.655Z');

  assert.deepEqual(parsed, {
    postId: '2091790034084982879',
    tag: 'tweet-2091790034084982879',
    title: 'Karma',
    body: 'a post',
    payloadTimestamp: 1787556582453,
    observedAt: '2026-08-24T07:29:42.655Z',
    transportLatencyMs: 202,
  });
  assert.doesNotMatch(JSON.stringify(parsed), /secret|registration_ids/);
});

test('headRequestUrl removes pagination and sets the reconciliation batch size', () => {
  const variables = encodeURIComponent(JSON.stringify({ listId: '42', count: 20, cursor: 'next' }));
  const result = new URL(headRequestUrl(`https://x.com/i/api/graphql/id/ListLatestTweetsTimeline?variables=${variables}`, 100));
  assert.deepEqual(JSON.parse(result.searchParams.get('variables')), { listId: '42', count: 100 });
});

test('buildScaleSummary reports loss, duplicates and both latency clocks', () => {
  const state = {
    groundTruth: new Map([
      ['1', { postedAt: '2026-08-24T07:29:42.000Z' }],
      ['2', { postedAt: '2026-08-24T07:30:00.000Z' }],
    ]),
    pushes: new Map([
      ['1', { observedAt: '2026-08-24T07:29:42.300Z', transportLatencyMs: 150 }],
      ['3', { observedAt: '2026-08-24T07:31:00.000Z', transportLatencyMs: 600 }],
    ]),
    pushCounts: new Map([['1', 2], ['3', 1]]),
    groundTruthErrors: 1,
  };
  const summary = buildScaleSummary(state);

  assert.equal(summary.coveragePct, 50);
  assert.deepEqual(summary.missingIds, ['2']);
  assert.deepEqual(summary.unmatchedPushIds, ['3']);
  assert.equal(summary.duplicateEvents, 1);
  assert.equal(summary.groundTruthErrors, 1);
  assert.equal(summary.transportLatency.p95Ms, 600);
  assert.equal(summary.endToEndLatency.p95Ms, 300);
});
