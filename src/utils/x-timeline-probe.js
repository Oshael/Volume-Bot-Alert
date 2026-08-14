'use strict';

// Bloco 2 (GATE, read-only) of the X-post/token match plan. This probe does NOT
// integrate with anything: it measures whether a single X session can read a
// timeline from this machine/IP, and what it costs. It reads credentials from
// the environment (.env, which is gitignored) and NEVER persists or logs the
// secrets. Run: node src/utils/x-timeline-probe.js
//
// Required env:
//   X_AUTH_TOKEN   cookie auth_token of a logged-in session
//   X_CT0          cookie ct0 (also used as x-csrf-token)
// Optional env:
//   X_LIST_ID                 private list id for ListLatestTweetsTimeline
//   X_BEARER                  override the public web-client bearer
//   X_LIST_TIMELINE_QUERY_ID  GraphQL queryId (else best-effort bundle scrape)
//   X_FEATURES                JSON override for the GraphQL features blob
//   X_TRANSACTION_ID          experimental x-client-transaction-id to send

require('dotenv').config();

// Public bearer shipped in X's web client JS. Not a secret; overridable.
const DEFAULT_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// A plausible recent feature set. When it is stale, X answers 400 and names the
// missing flag in the body -- that is the feedback loop, not a failure of auth.
const DEFAULT_FEATURES = {
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

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function buildHeaders({ authToken, ct0, bearer, transactionId }) {
  const headers = {
    authorization: `Bearer ${bearer}`,
    cookie: `auth_token=${authToken}; ct0=${ct0}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    'user-agent': UA,
    origin: 'https://x.com',
    referer: 'https://x.com/',
  };
  if (transactionId) headers['x-client-transaction-id'] = transactionId;
  return headers;
}

function readRateLimit(res) {
  const limit = res.headers.get('x-rate-limit-limit');
  const remaining = res.headers.get('x-rate-limit-remaining');
  const reset = res.headers.get('x-rate-limit-reset');
  if (!limit && !remaining && !reset) return null;
  const resetIso = reset ? new Date(Number(reset) * 1000).toISOString() : null;
  return { limit, remaining, reset, resetIso };
}

async function readBodySnippet(res) {
  try {
    const text = await res.text();
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return '(unreadable body)';
  }
}

// Layer 1: cheapest possible auth check. No queryId, no transaction-id.
// account/settings.json is what the web client uses and it accepts the
// OAuth2Session cookie auth (verify_credentials.json is OAuth1-era and 404s here).
async function verifyCredentials(headers) {
  const res = await fetch('https://api.twitter.com/1.1/account/settings.json', { headers });
  const rateLimit = readRateLimit(res);
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, status: res.status, screenName: body.screen_name || null, rateLimit };
  }
  return { ok: false, status: res.status, body: await readBodySnippet(res), rateLimit };
}

// Best-effort: pull the current ListLatestTweetsTimeline queryId from the web
// bundle. Fragile by nature; returns null and lets the caller fall back to env.
async function scrapeQueryId(headers) {
  try {
    const html = await (await fetch('https://x.com/', { headers: { 'user-agent': headers['user-agent'] } })).text();
    const bundleMatch = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"']*?\/main\.[a-f0-9]+\.js/);
    if (!bundleMatch) return null;
    const js = await (await fetch(bundleMatch[0])).text();
    const opMatch = js.match(/queryId:"([^"]+)"[^}]*?operationName:"ListLatestTweetsTimeline"/);
    return opMatch ? opMatch[1] : null;
  } catch {
    return null;
  }
}

// Layer 2: the real read. Surfaces whether the transaction-id wall / feature
// flags block us.
async function listTimeline({ headers, queryId, listId, features }) {
  const variables = { listId, count: 20 };
  const url =
    `https://x.com/i/api/graphql/${queryId}/ListLatestTweetsTimeline` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(features))}`;
  const res = await fetch(url, { headers });
  const rateLimit = readRateLimit(res);
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    const instructions =
      body?.data?.list?.tweets_timeline?.timeline?.instructions || [];
    const entries = instructions
      .filter((i) => i.type === 'TimelineAddEntries')
      .flatMap((i) => i.entries || []);
    return { ok: true, status: res.status, entries: entries.length, rateLimit };
  }
  return { ok: false, status: res.status, body: await readBodySnippet(res), rateLimit };
}

function fmtRate(rl) {
  return rl ? `${rl.remaining}/${rl.limit} (reset ${rl.resetIso})` : 'n/a';
}

async function main() {
  const authToken = readEnv('X_AUTH_TOKEN');
  const ct0 = readEnv('X_CT0');
  if (!authToken || !ct0) {
    console.error('Missing X_AUTH_TOKEN and/or X_CT0 in the environment (.env).');
    process.exitCode = 1;
    return;
  }
  const bearer = readEnv('X_BEARER') || DEFAULT_BEARER;
  const transactionId = readEnv('X_TRANSACTION_ID') || null;
  const headers = buildHeaders({ authToken, ct0, bearer, transactionId });

  console.log('=== Layer 1: session auth ===');
  const cred = await verifyCredentials(headers);
  if (cred.ok) {
    console.log(`OK  status=${cred.status}  as=@${cred.screenName}  rate=${fmtRate(cred.rateLimit)}`);
  } else if (cred.rateLimit) {
    // The v1.1 REST endpoints are deprecated and 404, but a per-user rate-limit
    // bucket coming back proves the session reached the authenticated layer.
    console.log(`AUTH OK (v1.1 endpoint deprecated: ${cred.status}) -- rate-limit bucket returned: ${fmtRate(cred.rateLimit)}`);
    console.log('  Session is authenticated. Proceeding to the GraphQL read.');
  } else {
    console.log(`FAIL status=${cred.status} with no rate-limit headers.`);
    console.log(`  body: ${cred.body}`);
    console.log('No auth bucket returned: cookies rejected or the IP is blocked. Stop here.');
    return;
  }

  const listId = readEnv('X_LIST_ID');
  if (!listId) {
    console.log('\n=== Layer 2 skipped: set X_LIST_ID to probe ListLatestTweetsTimeline ===');
    return;
  }

  let queryId = readEnv('X_LIST_TIMELINE_QUERY_ID');
  if (!queryId) {
    console.log('\nNo X_LIST_TIMELINE_QUERY_ID set; attempting bundle scrape...');
    queryId = await scrapeQueryId(headers);
  }
  if (!queryId) {
    console.log('Could not resolve a queryId (bundle scrape failed). Set X_LIST_TIMELINE_QUERY_ID and retry.');
    return;
  }

  let features = DEFAULT_FEATURES;
  const featuresOverride = readEnv('X_FEATURES');
  if (featuresOverride) {
    try { features = JSON.parse(featuresOverride); } catch { console.log('X_FEATURES is not valid JSON; using defaults.'); }
  }

  console.log(`\n=== Layer 2: ListLatestTweetsTimeline (queryId=${queryId}, list=${listId}) ===`);
  const timeline = await listTimeline({ headers, queryId, listId, features });
  if (timeline.ok) {
    console.log(`OK  status=${timeline.status}  entries=${timeline.entries}  rate=${fmtRate(timeline.rateLimit)}`);
    console.log('Timeline is readable with this session. Bloco 3 (continuous ingestion) is unblocked.');
  } else {
    console.log(`FAIL status=${timeline.status}  rate=${fmtRate(timeline.rateLimit)}`);
    console.log(`  body: ${timeline.body}`);
    console.log('Diagnose: 400 usually names a missing feature flag (set X_FEATURES); 404 often means the');
    console.log('x-client-transaction-id wall or a stale queryId. This is the measurement Bloco 2 exists for.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
