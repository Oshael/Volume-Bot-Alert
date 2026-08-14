'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTimeline } = require('../src/services/x-timeline-normalizer');

// Builders shaped like the real ListLatestTweetsTimeline response (the fixtures
// double as documentation of the response shape).
// Modern X user shape: screen_name under core, followers under relationship_counts.
function user(restId, screenName, followers) {
  return { rest_id: restId, core: { screen_name: screenName }, relationship_counts: { followers } };
}
function photo(url) {
  return { type: 'photo', media_url_https: url };
}
function tweetResult({ id, screenName, followers = 0, text, media = [], rt = null, visibility = false }) {
  const legacy = {
    id_str: id,
    full_text: text,
    lang: 'en',
    created_at: 'Wed Aug 13 23:00:00 +0000 2026',
    favorite_count: 5, retweet_count: 2, reply_count: 1, quote_count: 0,
  };
  if (media.length) legacy.extended_entities = { media };
  if (rt) legacy.retweeted_status_result = { result: rt };
  const tweet = {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: user(`${id}-u`, screenName, followers) } },
    views: { count: '1000' },
    legacy,
  };
  return visibility ? { __typename: 'TweetWithVisibilityResults', tweet } : tweet;
}
function item(entryId, result) {
  return { entryId, content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result } } } };
}
function cursor(cursorType, value) {
  return { content: { entryType: 'TimelineTimelineCursor', cursorType, value } };
}
function timeline(entries) {
  return { data: { list: { tweets_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } };
}

test('plain tweet with a photo normalizes to one post with media', () => {
  const body = timeline([item('100', tweetResult({ id: '100', screenName: 'binance', followers: 900, text: 'gm', media: [photo('http://img/a')] }))]);
  const { posts } = normalizeTimeline(body);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].post.postId, '100');
  assert.equal(posts[0].post.authorScreenName, 'binance');
  assert.equal(posts[0].post.authorFollowers, 900);
  assert.equal(posts[0].post.retweetOfPostId, null);
  assert.deepEqual(posts[0].media, [{ mediaIndex: 0, mediaUrl: 'http://img/a', mediaType: 'photo' }]);
});

test('TweetWithVisibilityResults is unwrapped, not dropped', () => {
  const body = timeline([item('101', tweetResult({ id: '101', screenName: 'toly', text: 'hi', visibility: true }))]);
  const { posts } = normalizeTimeline(body);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].post.postId, '101');
  assert.equal(posts[0].post.authorScreenName, 'toly');
});

test('retweet: reach is the retweeter, media/text come from the original', () => {
  const original = tweetResult({ id: '200', screenName: 'origauthor', followers: 50, text: 'the bear photo', media: [photo('http://img/bear')] });
  const rt = tweetResult({ id: '201', screenName: 'himgajria', followers: 180000, text: 'RT @origauthor: the bear photo', rt: original });
  const { posts } = normalizeTimeline(timeline([item('201', rt)]));
  assert.equal(posts.length, 1);
  const { post, media } = posts[0];
  assert.equal(post.postId, '201', 'post id is the retweet action');
  assert.equal(post.authorScreenName, 'himgajria', 'reach is the retweeter');
  assert.equal(post.authorFollowers, 180000);
  assert.equal(post.retweetOfPostId, '200', 'points at the original');
  assert.equal(post.text, 'the bear photo', 'text from the original, not the RT prefix');
  assert.deepEqual(media, [{ mediaIndex: 0, mediaUrl: 'http://img/bear', mediaType: 'photo' }]);
});

test('cursors are captured, not counted as posts', () => {
  const body = timeline([
    item('300', tweetResult({ id: '300', screenName: 'a', text: 'x' })),
    cursor('Top', 'CURSOR_TOP'),
    cursor('Bottom', 'CURSOR_BOTTOM'),
  ]);
  const { posts, cursors } = normalizeTimeline(body);
  assert.equal(posts.length, 1);
  assert.deepEqual(cursors, { top: 'CURSOR_TOP', bottom: 'CURSOR_BOTTOM' });
});

test('duplicate post ids within a batch collapse to one', () => {
  const body = timeline([
    item('400', tweetResult({ id: '400', screenName: 'a', text: 'x' })),
    item('400b', tweetResult({ id: '400', screenName: 'a', text: 'x' })),
  ]);
  assert.equal(normalizeTimeline(body).posts.length, 1);
});

test('tweet without media yields an empty media array', () => {
  const { posts } = normalizeTimeline(timeline([item('500', tweetResult({ id: '500', screenName: 'a', text: 'no media' }))]));
  assert.deepEqual(posts[0].media, []);
});

test('malformed / non-tweet entries are skipped, not thrown on', () => {
  const body = timeline([
    { entryId: 'junk', content: { entryType: 'TimelineTimelineItem', itemContent: {} } },
    item('600', tweetResult({ id: '600', screenName: 'a', text: 'ok' })),
  ]);
  const { posts } = normalizeTimeline(body);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].post.postId, '600');
});

test('legacy user shape (screen_name/followers_count in legacy) still resolves', () => {
  const legacyUserTweet = {
    __typename: 'Tweet',
    rest_id: '700',
    core: { user_results: { result: { rest_id: '700-u', legacy: { screen_name: 'oldshape', followers_count: 1234 } } } },
    legacy: { id_str: '700', full_text: 'hi', lang: 'en', created_at: 'Wed Aug 13 23:00:00 +0000 2026' },
  };
  const { posts } = normalizeTimeline(timeline([item('700', legacyUserTweet)]));
  assert.equal(posts[0].post.authorScreenName, 'oldshape');
  assert.equal(posts[0].post.authorFollowers, 1234);
});

test('empty / shapeless body returns no posts and no cursors', () => {
  assert.deepEqual(normalizeTimeline({}), { posts: [], cursors: {} });
  assert.deepEqual(normalizeTimeline(null), { posts: [], cursors: {} });
});
