'use strict';

// Bloco 3, slice 3.2: pure normalizer. Turns a ListLatestTweetsTimeline GraphQL
// response into normalized posts + pagination cursors. No I/O, no X calls -- the
// durable core, exercised by fixtures shaped like the responses measured in
// Bloco 2. Handles the two gotchas the plan calls out:
//   - TweetWithVisibilityResults wraps the real tweet under .tweet (not
//     unwrapping = silently dropping every visibility-noticed post).
//   - Retweets: media and text come from the ORIGINAL, but the reach that
//     matters is the retweeter's (the monitored account), so author fields are
//     the retweeter and retweet_of_post_id points at the original.

function unwrapTweet(result) {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults') return result.tweet || null;
  if (result.tweet && !result.legacy) return result.tweet;
  return result;
}

function userOf(tweet) {
  return tweet?.core?.user_results?.result || null;
}

// X migrated the user object: screen_name moved to core, followers to
// relationship_counts. Keep the legacy paths as fallback (older payloads / tests).
function screenNameOf(user) {
  return user?.core?.screen_name || user?.legacy?.screen_name || null;
}

function followersOf(user) {
  const n = user?.relationship_counts?.followers ?? user?.legacy?.followers_count;
  return Number.isFinite(n) ? n : null;
}

function mediaList(legacy) {
  return legacy?.extended_entities?.media || legacy?.entities?.media || [];
}

function engagementOf(legacy, tweet) {
  const views = Number(tweet?.views?.count);
  return {
    likes: legacy?.favorite_count ?? null,
    retweets: legacy?.retweet_count ?? null,
    replies: legacy?.reply_count ?? null,
    quotes: legacy?.quote_count ?? null,
    views: Number.isFinite(views) ? views : null,
  };
}

function postIdOf(tweet, legacy) {
  return tweet?.rest_id || legacy?.id_str || null;
}

function toIso(createdAt) {
  const ms = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function buildMedia(legacy) {
  return mediaList(legacy)
    .map((m, index) => ({
      mediaIndex: index,
      mediaUrl: m.media_url_https || m.media_url || null,
      mediaType: m.type || null,
    }))
    .filter((m) => m.mediaUrl);
}

// One timeline item -> { post, media } or null (non-tweet / malformed).
function normalizeEntry(entry) {
  const result = entry?.content?.itemContent?.tweet_results?.result;
  const tweet = unwrapTweet(result);
  const legacy = tweet?.legacy;
  if (!tweet || !legacy) return null;

  const monitored = userOf(tweet);
  const rtResult = legacy.retweeted_status_result?.result;
  const original = rtResult ? unwrapTweet(rtResult) : tweet;
  const contentLegacy = original?.legacy || legacy;
  const isRt = Boolean(rtResult);

  const postId = postIdOf(tweet, legacy);
  if (!postId) return null;

  const post = {
    postId,
    authorRestId: monitored?.rest_id || null,
    authorScreenName: screenNameOf(monitored),
    authorFollowers: followersOf(monitored),
    text: contentLegacy.full_text ?? null,
    lang: contentLegacy.lang || null,
    postedAt: toIso(legacy.created_at),
    retweetOfPostId: isRt ? postIdOf(original, contentLegacy) : null,
    engagement: engagementOf(contentLegacy, original),
  };
  return { post, media: buildMedia(contentLegacy) };
}

function collectCursors(entries) {
  const cursors = {};
  for (const entry of entries) {
    const content = entry?.content || {};
    const isCursor = content.entryType === 'TimelineTimelineCursor'
      || content.__typename === 'TimelineTimelineCursor';
    if (!isCursor) continue;
    const kind = String(content.cursorType || '').toLowerCase();
    if (kind) cursors[kind] = content.value || null;
  }
  return cursors;
}

function normalizeTimeline(body) {
  const instructions = body?.data?.list?.tweets_timeline?.timeline?.instructions || [];
  const entries = instructions
    .filter((i) => i.type === 'TimelineAddEntries')
    .flatMap((i) => i.entries || []);

  const seen = new Set();
  const posts = [];
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    if (seen.has(normalized.post.postId)) continue; // dedupe within the batch
    seen.add(normalized.post.postId);
    posts.push(normalized);
  }
  return { posts, cursors: collectCursors(entries) };
}

module.exports = { normalizeTimeline, normalizeEntry };
