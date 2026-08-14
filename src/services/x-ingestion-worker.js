'use strict';

// Bloco 3, slice 3.4: X ingestion worker. Each cycle refreshes the session pool,
// then polls the head of every enabled list with a pooled session, normalizes
// the timeline, persists posts (idempotently), and advances the list cursor. The
// pool self-heals ct0 and quarantines a session on auth failure. Isolated
// 'x-ingest' group, disabled by default. It reads x_session / x_list and writes
// x_post / x_post_media only; it never touches the Solana or Robinhood paths.

const xSessionModel = require('../models/x-session');
const xListModel = require('../models/x-list');
const xPostModel = require('../models/x-post');
const { createSessionPool } = require('./x-session-pool');
const { callGraphql } = require('./x-graphql-client');
const { normalizeTimeline } = require('./x-timeline-normalizer');

const LIST_ENDPOINT = 'timeline';
const OPERATION = 'ListLatestTweetsTimeline';

// Feature set measured working in Bloco 2. When a flag goes stale X answers 400
// and names the missing flag in the body -- that surfaces as a per-list error
// here, not a silent drop.
const LIST_TIMELINE_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const DEFAULTS = {
  intervalMs: 15_000,
  count: 20,
  maxListsPerCycle: 25,
};

function createXIngestionWorker(options = {}) {
  const sessionModel = options.sessionModel || xSessionModel;
  const listModel = options.listModel || xListModel;
  const postModel = options.postModel || xPostModel;
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const call = options.call || callGraphql;
  const normalize = options.normalize || normalizeTimeline;
  const pool = options.pool || createSessionPool({ model: sessionModel, now });

  let timer = null;
  let running = false;
  let draining = false;
  const settings = { ...DEFAULTS };
  const metrics = {
    cycles: 0, polls: 0, postsSeen: 0, saved: 0, skipped: 0, errors: 0,
    noSession: 0, lastRunAt: null,
  };

  async function persistPosts(posts) {
    for (const item of posts) {
      await postModel.savePost(item);
      metrics.saved += 1;
    }
  }

  // Poll one list once: acquire a session, call, report the outcome back to the
  // pool (rate limit / ct0 / quarantine), then persist and advance the cursor.
  // Returns false when no session was available (stop polling further lists).
  async function pollList(list) {
    if (!list.queryId) { metrics.skipped += 1; return true; }
    const session = pool.acquire(LIST_ENDPOINT);
    if (!session) { metrics.noSession += 1; return false; }

    const result = await call({
      session,
      queryId: list.queryId,
      operationName: OPERATION,
      variables: { listId: list.listId, count: settings.count },
      features: LIST_TIMELINE_FEATURES,
    });
    await pool.report(session, LIST_ENDPOINT, {
      status: result.status, rateLimit: result.rateLimit, newCt0: result.newCt0,
    });
    metrics.polls += 1;

    if (!result.ok) {
      metrics.errors += 1;
      logger.warn?.(`[XIngest] list ${list.listId} poll failed status=${result.status}`);
      return true;
    }

    const { posts, cursors } = normalize(result.body);
    metrics.postsSeen += posts.length;
    await persistPosts(posts);
    await listModel.updateCursor(list.id, { cursor: cursors?.top || null, now });
    return true;
  }

  async function runOnce() {
    if (draining) return;
    draining = true;
    try {
      metrics.cycles += 1;
      metrics.lastRunAt = now();
      const active = await pool.refresh();
      if (!active) return;
      const lists = (await listModel.listActive()).slice(0, settings.maxListsPerCycle);
      for (const list of lists) {
        const keepGoing = await pollList(list);
        if (!keepGoing) break; // pool exhausted this cycle
      }
    } catch (err) {
      metrics.errors += 1;
      logger.error?.(`[XIngest] cycle error: ${err.message}`);
    } finally {
      draining = false;
    }
  }

  function start(config = {}) {
    if (running) return;
    Object.assign(settings, {
      intervalMs: Math.max(1_000, Number(config.intervalMs) || DEFAULTS.intervalMs),
      count: Math.max(1, Number(config.count) || DEFAULTS.count),
      maxListsPerCycle: Math.max(1, Number(config.maxListsPerCycle) || DEFAULTS.maxListsPerCycle),
    });
    running = true;
    void runOnce();
    timer = setInterval(() => { void runOnce(); }, settings.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return { running, settings: { ...settings }, poolSize: pool.size?.() ?? null, ...metrics };
  }

  return { start, stop, runOnce, getStatus };
}

module.exports = createXIngestionWorker();
module.exports.createXIngestionWorker = createXIngestionWorker;
