'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXIngestionWorker } = require('../src/services/x-ingestion-worker');

// A single-session pool stub: hands out its session while budget lasts, records
// what the worker reports back.
function fakePool(session) {
  const state = { acquired: 0, reports: [], refreshed: 0, exhausted: false };
  return {
    state,
    refresh: async () => { state.refreshed += 1; return session ? 1 : 0; },
    acquire: () => {
      if (!session || state.exhausted) return null;
      state.acquired += 1;
      return session;
    },
    report: async (s, endpoint, result) => state.reports.push({ endpoint, result }),
    size: () => (session ? 1 : 0),
  };
}

function fakeListModel(lists) {
  const cursors = [];
  const queryIds = [];
  return {
    cursors,
    queryIds,
    listActive: async () => lists.map((l) => ({ ...l })),
    updateCursor: async (id, patch) => cursors.push({ id, ...patch }),
    updateQueryId: async (id, queryId) => queryIds.push({ id, queryId }),
  };
}

function fakePostModel() {
  const saved = [];
  return { saved, savePost: async (item) => saved.push(item) };
}

test('a cycle polls a list, persists posts, advances the cursor and reports', async () => {
  const pool = fakePool({ id: 1, authToken: 'a', ct0: 'c' });
  const listModel = fakeListModel([{ id: 7, listId: '900', queryId: 'QID' }]);
  const postModel = fakePostModel();
  const call = async () => ({
    ok: true, status: 200, rateLimit: { remaining: 499 }, newCt0: 'c2', body: {},
  });
  const normalize = () => ({
    posts: [{ post: { postId: 'p1' }, media: [] }, { post: { postId: 'p2' }, media: [] }],
    cursors: { top: 'TOP' },
  });

  const worker = createXIngestionWorker({ pool, listModel, postModel, call, normalize });
  await worker.runOnce();

  assert.equal(postModel.saved.length, 2, 'both posts persisted');
  assert.deepEqual(listModel.cursors[0], { id: 7, cursor: 'TOP', now: listModel.cursors[0].now });
  assert.equal(pool.state.reports.length, 1);
  assert.equal(pool.state.reports[0].result.newCt0, 'c2', 'ct0 rotation forwarded to the pool');
  assert.equal(worker.getStatus().saved, 2);
});

test('a query resolver failure is contained and never calls GraphQL', async () => {
  const pool = fakePool({ id: 1 });
  const listModel = fakeListModel([{ id: 7, listId: '900', queryId: null }]);
  const postModel = fakePostModel();
  let called = 0;
  const call = async () => { called += 1; return { ok: true, status: 200, body: {} }; };

  const worker = createXIngestionWorker({
    pool,
    listModel,
    postModel,
    call,
    resolveQueryId: async () => { throw new Error('manifest unavailable'); },
    normalize: () => ({ posts: [], cursors: {} }),
    logger: { error: () => {}, warn: () => {} },
  });
  await worker.runOnce();

  assert.equal(called, 0, 'no GraphQL call without a resolved queryId');
  assert.equal(worker.getStatus().errors, 1);
  assert.equal(pool.state.reports.length, 0);
});

test('no active sessions -> the cycle does no work', async () => {
  const pool = fakePool(null); // refresh returns 0
  const listModel = fakeListModel([{ id: 7, listId: '900', queryId: 'QID' }]);
  const postModel = fakePostModel();
  let listed = 0;
  listModel.listActive = async () => { listed += 1; return []; };

  const worker = createXIngestionWorker({
    pool, listModel, postModel, call: async () => ({ ok: true, status: 200, body: {} }),
    normalize: () => ({ posts: [], cursors: {} }),
  });
  await worker.runOnce();

  assert.equal(listed, 0, 'lists are not even fetched when the pool is empty');
  assert.equal(postModel.saved.length, 0);
});

test('a failed poll still reports to the pool and skips persistence', async () => {
  const pool = fakePool({ id: 1, ct0: 'c' });
  const listModel = fakeListModel([{ id: 7, listId: '900', queryId: 'QID' }]);
  const postModel = fakePostModel();
  const call = async () => ({ ok: false, status: 403, rateLimit: null, body: null });

  const worker = createXIngestionWorker({
    pool, listModel, postModel, call, normalize: () => ({ posts: [], cursors: {} }),
  });
  await worker.runOnce();

  assert.equal(pool.state.reports[0].result.status, 403, 'auth failure forwarded so the pool can disable');
  assert.equal(postModel.saved.length, 0);
  assert.equal(listModel.cursors.length, 0, 'cursor not advanced on a failed poll');
  assert.equal(worker.getStatus().errors, 1);
  assert.equal(worker.getStatus().backedOff, 0, 'auth failure disables the session, not the list');
});

test('pool exhaustion stops polling the remaining lists this cycle', async () => {
  const pool = fakePool({ id: 1, ct0: 'c' });
  pool.exhaustAfterFirst = true;
  const listModel = fakeListModel([
    { id: 1, listId: '1', queryId: 'Q' },
    { id: 2, listId: '2', queryId: 'Q' },
  ]);
  const postModel = fakePostModel();
  let calls = 0;
  const call = async () => {
    calls += 1;
    pool.state.exhausted = true; // budget gone after the first acquire
    return { ok: true, status: 200, rateLimit: { remaining: 0 }, body: {} };
  };

  const worker = createXIngestionWorker({
    pool, listModel, postModel, call, normalize: () => ({ posts: [], cursors: {} }),
  });
  await worker.runOnce();

  assert.equal(calls, 1, 'second list not polled once the pool is exhausted');
  assert.equal(worker.getStatus().noSession, 1);
});

test('a thrown list error is backed off without starving the next list', async () => {
  let nowMs = 1_000;
  const pool = fakePool({ id: 1, ct0: 'c' });
  const listModel = fakeListModel([
    { id: 1, listId: 'broken', queryId: 'Q' },
    { id: 2, listId: 'healthy', queryId: 'Q' },
  ]);
  const calls = [];
  const call = async ({ variables }) => {
    calls.push(variables.listId);
    if (variables.listId === 'broken') throw new Error('network down');
    return { ok: true, status: 200, body: {} };
  };
  const worker = createXIngestionWorker({
    pool,
    listModel,
    postModel: fakePostModel(),
    call,
    normalize: () => ({ posts: [], cursors: {} }),
    now: () => nowMs,
    logger: { error: () => {}, warn: () => {} },
  });

  await worker.runOnce();
  assert.deepEqual(calls, ['broken', 'healthy']);

  nowMs += 1_000;
  await worker.runOnce();
  assert.deepEqual(calls, ['broken', 'healthy', 'healthy'], 'broken list remains in backoff');
  assert.equal(worker.getStatus().backedOff, 1);
});

test('default polling interval is below the ten-second freshness target', () => {
  const worker = createXIngestionWorker();
  assert.equal(worker.getStatus().settings.intervalMs, 5_000);
});

test('a missing queryId is resolved and persisted before the first poll', async () => {
  const pool = fakePool({ id: 1, authToken: 'a', ct0: 'c' });
  const listModel = fakeListModel([{ id: 7, listId: '900', queryId: null }]);
  let calledQueryId = null;
  const worker = createXIngestionWorker({
    pool,
    listModel,
    postModel: fakePostModel(),
    resolveQueryId: async () => 'AUTO',
    call: async ({ queryId }) => {
      calledQueryId = queryId;
      return { ok: true, status: 200, body: {} };
    },
    normalize: () => ({ posts: [], cursors: {} }),
  });

  await worker.runOnce();

  assert.equal(calledQueryId, 'AUTO');
  assert.deepEqual(listModel.queryIds, [{ id: 7, queryId: 'AUTO' }]);
  assert.equal(worker.getStatus().queryRefreshes, 1);
});

test('a stale queryId is refreshed, persisted and retried only once', async () => {
  const pool = fakePool({ id: 1, authToken: 'a', ct0: 'c' });
  const listModel = fakeListModel([{ id: 7, listId: '900', queryId: 'OLD' }]);
  const calls = [];
  const worker = createXIngestionWorker({
    pool,
    listModel,
    postModel: fakePostModel(),
    resolveQueryId: async () => 'NEW',
    call: async ({ queryId }) => {
      calls.push(queryId);
      return queryId === 'OLD'
        ? { ok: false, status: 404, body: null }
        : { ok: true, status: 200, body: {} };
    },
    normalize: () => ({ posts: [], cursors: {} }),
  });

  await worker.runOnce();

  assert.deepEqual(calls, ['OLD', 'NEW']);
  assert.deepEqual(listModel.queryIds, [{ id: 7, queryId: 'NEW' }]);
  assert.equal(worker.getStatus().queryRetries, 1);
  assert.equal(worker.getStatus().errors, 0);
});
