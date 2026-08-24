'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compareFollowing, followTarget, isFollowMutation, paginatedUrl, parseFollowingPage,
} = require('../src/utils/x-following-overlap-probe');

test('parseFollowingPage reads migrated and legacy handles plus the bottom cursor', () => {
  const body = {
    data: { user: { result: { timeline: { timeline: { instructions: [{
      type: 'TimelineAddEntries',
      entries: [
        { content: { itemContent: { user_results: { result: {
          rest_id: '1', core: { screen_name: 'new_shape' },
        } } } } },
        { content: { itemContent: { user_results: { result: {
          rest_id: '2', legacy: { screen_name: 'legacy_shape' },
        } } } } },
        { content: { cursorType: 'Bottom', value: 'next-page' } },
      ],
    }] } } } } },
  };

  assert.deepEqual(parseFollowingPage(body), {
    users: [
      { restId: '1', screenName: 'new_shape' },
      { restId: '2', screenName: 'legacy_shape' },
    ],
    bottomCursor: 'next-page',
  });
});

test('paginatedUrl preserves captured query data and replaces cursor and count', () => {
  const variables = encodeURIComponent(JSON.stringify({ userId: '10', count: 20, cursor: 'old' }));
  const result = new URL(paginatedUrl(
    `https://x.com/i/api/graphql/query/Following?variables=${variables}&features=%7B%7D`,
    100,
    'new',
  ));

  assert.deepEqual(JSON.parse(result.searchParams.get('variables')), {
    userId: '10', count: 100, cursor: 'new',
  });
  assert.equal(result.searchParams.get('features'), '{}');
});

test('compareFollowing finds overlap by stable ID and checks candidate handles', () => {
  const accountA = {
    label: 'X', handle: 'account_x', pages: 2, complete: true,
    users: [
      { restId: '1', screenName: 'same_person' },
      { restId: '2', screenName: 'only_x' },
    ],
  };
  const accountB = {
    label: 'Y', handle: 'account_y', pages: 1, complete: true,
    users: [
      { restId: '1', screenName: 'renamed_person' },
      { restId: '3', screenName: 'only_y' },
    ],
  };

  const result = compareFollowing(accountA, accountB, ['only_x', 'only_y', 'nobody']);
  assert.equal(result.overlapCount, 1);
  assert.deepEqual(result.overlap, [{ restId: '1', screenName: 'same_person' }]);
  assert.deepEqual(result.candidates, [
    { handle: 'only_x', followedBy: ['X'] },
    { handle: 'only_y', followedBy: ['Y'] },
    { handle: 'nobody', followedBy: [] },
  ]);
  assert.deepEqual(result.accounts.map(({ followingRead }) => followingRead), [2, 2]);
});

test('follow mutation detection extracts the followed account from the response', () => {
  const request = {
    method: () => 'POST',
    url: () => 'https://x.com/i/api/1.1/friendships/create.json',
    postData: () => 'user_id=42',
  };

  assert.equal(isFollowMutation(request), true);
  assert.deepEqual(followTarget(request, { id_str: '42', screen_name: 'target' }), {
    restId: '42', screenName: 'target',
  });
});
