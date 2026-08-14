'use strict';

// Bloco 3, slice 3.3: authenticated X GraphQL client. Builds the session headers
// measured in Bloco 2 (cookies + public bearer + csrf; no transaction-id needed),
// reads the rate-limit budget, and captures a rotated ct0 from Set-Cookie so the
// pool can self-heal the session. Proxy dispatch is a seam, deferred until real
// proxies exist (see dispatcherFor).

const PUBLIC_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

function buildHeaders(session) {
  return {
    authorization: `Bearer ${session.bearer || PUBLIC_BEARER}`,
    cookie: `auth_token=${session.authToken}; ct0=${session.ct0}`,
    'x-csrf-token': session.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    'user-agent': UA,
    origin: 'https://x.com',
    referer: 'https://x.com/',
  };
}

function parseRateLimit(headers) {
  const remaining = headers.get('x-rate-limit-remaining');
  const limit = headers.get('x-rate-limit-limit');
  const reset = headers.get('x-rate-limit-reset');
  if (remaining == null && reset == null) return null;
  return {
    limit: limit != null ? Number(limit) : null,
    remaining: remaining != null ? Number(remaining) : null,
    resetMs: reset != null ? Number(reset) * 1000 : null,
  };
}

function setCookieList(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

// X rotates ct0 periodically and returns the new value via Set-Cookie. Return it
// only when it actually changed so the caller can persist the fresh token.
function extractNewCt0(headers, currentCt0) {
  for (const cookie of setCookieList(headers)) {
    const match = /(?:^|;\s*)ct0=([^;]+)/.exec(cookie);
    if (match && match[1] && match[1] !== currentCt0) return match[1];
  }
  return null;
}

// Proxy dispatch seam. The alpha runs on the home IP with no proxy, so this
// returns null (plain fetch). When proxies are contracted, add undici and return
// `new ProxyAgent(proxyUrl)` here, validated against a real proxy -- not built blind.
function dispatcherFor(proxyUrl) {
  if (!proxyUrl) return null;
  return null; // TODO(undici ProxyAgent): wire when proxies exist
}

async function callGraphql({ session, queryId, operationName, variables, features, fetchImpl = fetch }) {
  const url = `${GRAPHQL_BASE}/${queryId}/${operationName}`
    + `?variables=${encodeURIComponent(JSON.stringify(variables))}`
    + `&features=${encodeURIComponent(JSON.stringify(features))}`;
  const options = { headers: buildHeaders(session) };
  const dispatcher = dispatcherFor(session.proxyUrl);
  if (dispatcher) options.dispatcher = dispatcher;

  const res = await fetchImpl(url, options);
  const rateLimit = parseRateLimit(res.headers);
  const newCt0 = extractNewCt0(res.headers, session.ct0);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body, rateLimit, newCt0 };
}

module.exports = {
  callGraphql,
  buildHeaders,
  parseRateLimit,
  extractNewCt0,
  dispatcherFor,
  PUBLIC_BEARER,
};
