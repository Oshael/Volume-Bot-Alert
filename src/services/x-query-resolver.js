'use strict';

// Resolves the private GraphQL queryId from the authenticated X web bootstrap.
// The HTML owns the webpack chunk manifest; bundle.LoggedInMain owns the
// ListLatestTweetsTimeline operation descriptor. No bundle code is evaluated.

const { dispatcherFor, UA } = require('./x-graphql-client');

const HOME_URL = 'https://x.com/home';
const OPERATION = 'ListLatestTweetsTimeline';
const CHUNK_NAME = 'bundle.LoggedInMain';

function resolverError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function scriptSources(html) {
  return [...String(html || '').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => match[1].replaceAll('&amp;', '&'));
}

function extractOperationQueryId(source, operationName = OPERATION) {
  const escaped = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const queryFirst = new RegExp(`queryId:"([^"]+)"[^}]*?operationName:"${escaped}"`);
  const operationFirst = new RegExp(`operationName:"${escaped}"[^}]*?queryId:"([^"]+)"`);
  const match = queryFirst.exec(source) || operationFirst.exec(source);
  return match?.[1] || null;
}

function extractOperationChunkUrl(html, chunkName = CHUNK_NAME) {
  const source = String(html || '');
  const escapedName = chunkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameMatch = new RegExp(`(\\d+):"${escapedName}"`).exec(source);
  if (!nameMatch) return null;

  const chunkId = nameMatch[1];
  const values = [...source.matchAll(new RegExp(`${chunkId}:"([^"]+)"`, 'g'))]
    .map((match) => match[1]);
  const hash = values.find((value) => value !== chunkName && /^[a-f0-9]+$/i.test(value));
  if (!hash) return null;

  const hashMatch = new RegExp(`${chunkId}:"${hash}"`).exec(source);
  const suffixMatch = hashMatch
    ? /\}\)\[e\]\+"([A-Za-z0-9._-]+\.js)"/.exec(source.slice(hashMatch.index))
    : null;
  if (!suffixMatch) return null;

  const mainSource = scriptSources(source)
    .find((url) => /\/responsive-web\/client-web\/main\.[A-Za-z0-9_-]+\.js$/.test(url));
  if (!mainSource) return null;
  const baseUrl = new URL('./', new URL(mainSource, HOME_URL));
  return new URL(`${chunkName}.${hash}${suffixMatch[1]}`, baseUrl).toString();
}

async function fetchText(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    throw resolverError('X_QUERY_RESOLVE_HTTP', `X query resolver HTTP ${response.status}`);
  }
  return response.text();
}

async function resolveQueryId({ session, fetchImpl = fetch }) {
  const dispatcher = dispatcherFor(session.proxyUrl);
  const pageOptions = {
    headers: {
      cookie: `auth_token=${session.authToken}; ct0=${session.ct0}`,
      'user-agent': UA,
      referer: HOME_URL,
    },
  };
  if (dispatcher) pageOptions.dispatcher = dispatcher;
  const html = await fetchText(HOME_URL, pageOptions, fetchImpl);
  const chunkUrl = extractOperationChunkUrl(html);
  if (!chunkUrl) {
    throw resolverError('X_QUERY_CHUNK_NOT_FOUND', 'X LoggedInMain chunk was not found');
  }

  // CDN assets are public. Never forward auth_token/ct0 to abs.twimg.com.
  const assetOptions = { headers: { 'user-agent': UA, referer: HOME_URL } };
  if (dispatcher) assetOptions.dispatcher = dispatcher;
  const source = await fetchText(chunkUrl, assetOptions, fetchImpl);
  const queryId = extractOperationQueryId(source);
  if (!queryId) {
    throw resolverError('X_QUERY_ID_NOT_FOUND', `${OPERATION} queryId was not found`);
  }
  return queryId;
}

module.exports = {
  resolveQueryId,
  extractOperationChunkUrl,
  extractOperationQueryId,
  scriptSources,
  HOME_URL,
  OPERATION,
};
