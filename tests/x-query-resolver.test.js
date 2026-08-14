'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveQueryId, extractOperationChunkUrl, extractOperationQueryId,
} = require('../src/services/x-query-resolver');

const MANIFEST = `
  <script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script>
  <script>
    r.u=e=>""+(({123:"bundle.Other",56771:"bundle.LoggedInMain"})[e]||e)+"."
      +({123:"aaaaaaa",56771:"107fc08"})[e]+"a.js"
  </script>`;

test('extractOperationChunkUrl resolves LoggedInMain from the inline webpack manifest', () => {
  assert.equal(
    extractOperationChunkUrl(MANIFEST),
    'https://abs.twimg.com/responsive-web/client-web/bundle.LoggedInMain.107fc08a.js',
  );
});

test('extractOperationChunkUrl fails safely when the authenticated manifest shape is absent', () => {
  assert.equal(extractOperationChunkUrl('<script src="main.js"></script>'), null);
});

test('extractOperationQueryId accepts either descriptor field order', () => {
  assert.equal(
    extractOperationQueryId('e.exports={queryId:"Q1",operationName:"ListLatestTweetsTimeline"}'),
    'Q1',
  );
  assert.equal(
    extractOperationQueryId('e.exports={operationName:"ListLatestTweetsTimeline",queryId:"Q2"}'),
    'Q2',
  );
  assert.equal(extractOperationQueryId('operationName:"Other"'), null);
});

test('resolveQueryId authenticates only the X page and never forwards cookies to the CDN', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://x.com/home') {
      return { ok: true, status: 200, text: async () => MANIFEST };
    }
    return {
      ok: true,
      status: 200,
      text: async () => 'e.exports={queryId:"LIVE",operationName:"ListLatestTweetsTimeline"}',
    };
  };

  const queryId = await resolveQueryId({
    session: { authToken: 'AUTH', ct0: 'CT0', proxyUrl: null },
    fetchImpl,
  });
  assert.equal(queryId, 'LIVE');
  assert.match(calls[0].options.headers.cookie, /auth_token=AUTH/);
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[1].options.headers.cookie, undefined);
  assert.match(calls[1].url, /bundle\.LoggedInMain\.107fc08a\.js$/);
});

test('resolveQueryId surfaces a typed error when the operation disappears', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => (url === 'https://x.com/home' ? MANIFEST : 'no operation here'),
  });
  await assert.rejects(
    resolveQueryId({ session: { authToken: 'A', ct0: 'C' }, fetchImpl }),
    (error) => error.code === 'X_QUERY_ID_NOT_FOUND',
  );
});
