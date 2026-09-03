const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const { createLiquidityTimedDatabase } = require('../src/utils/robinhood-liquidity-db-timing');

function fixture(options = {}) {
  let clock = 0;
  const events = [];
  const calls = [];
  const released = [];
  const result = { rows: [{ value: 'unchanged' }], rowCount: 1 };
  const client = Object.assign(new EventEmitter(), {
    processID: 4321,
    release(error) { released.push(error); },
    query(text, params, callback) {
      calls.push({ text, params });
      clock += options.queryMs ?? 30;
      if (options.failureMode === 'throw') throw options.error;
      if (options.failureMode === 'event') client.emit('error', options.error);
      callback(options.error, result);
    },
  });
  const pool = {
    totalCount: 1, idleCount: 0, waitingCount: 2,
    async connect() {
      clock += options.acquireMs ?? 2000;
      if (options.connectError) throw options.connectError;
      return client;
    },
  };
  const originalQuery = () => assert.fail('must not dispatch the query twice');
  const database = { pool, query: originalQuery };
  const timed = createLiquidityTimedDatabase(database, {
    now: () => clock, emit: (event) => events.push(event), ...options.timing,
  });
  return { timed, database, originalQuery, events, calls, released, result, client };
}

describe('Liquidity-only database timing', () => {
  it('separates connection acquisition from round trip without logging SQL or values', async () => {
    const f = fixture();
    const sql = 'SELECT * FROM robinhood_v4_liquidity_replay_state WHERE pool_id = $1 /* private */';
    const params = ['private-pool'];
    assert.equal(await f.timed.query(sql, params), f.result);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].text, sql);
    assert.equal(f.calls[0].params, params);
    assert.deepEqual(f.released, [undefined]);
    assert.equal(f.client.listenerCount('error'), 0);
    assert.equal(f.database.query, f.originalQuery);
    assert.equal(f.events.length, 1);
    const event = f.events[0];
    assert.equal(event.acquireMs, 2000);
    assert.equal(event.roundTripMs, 30);
    assert.equal(event.totalMs, 2030);
    assert.equal(event.backendPid, 4321);
    assert.equal(event.operation, 'v4_ranges');
    assert.equal(event.failed, false);
    assert.equal(event.poolWhileAcquiring.waiting, 2);
    assert.ok(Number.isFinite(Date.parse(event.startedAt)));
    assert.ok(Number.isFinite(Date.parse(event.finishedAt)));
    assert.doesNotMatch(JSON.stringify(event), /private|SELECT/);
  });

  it('does not log fast queries and honors disabled diagnostics', async () => {
    const fast = fixture({ acquireMs: 1, queryMs: 20 });
    assert.equal(await fast.timed.query('SELECT 1'), fast.result);
    assert.deepEqual(fast.events, []);
    const disabled = fixture({ timing: { enabled: false } });
    assert.equal(disabled.timed, disabled.database);
    const injected = { async query() {} };
    assert.equal(createLiquidityTimedDatabase(injected), injected);
  });

  it('propagates acquisition failures without dispatch, release or invented round-trip time', async () => {
    const error = Object.assign(new Error('private connection details'), { code: 'ETIMEDOUT' });
    const f = fixture({ connectError: error });
    await assert.rejects(f.timed.query('SELECT 1'), (received) => received === error);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.released, []);
    assert.equal(f.events[0].roundTripMs, null);
    assert.equal(f.events[0].backendPid, null);
    assert.equal(f.events[0].acquireMs, 2000);
    assert.equal(f.events[0].errorCode, 'ETIMEDOUT');
    assert.doesNotMatch(JSON.stringify(f.events), /private/);
  });

  it('preserves query and socket errors and releases each failed client exactly once', async () => {
    for (const failureMode of ['callback', 'throw', 'event']) {
      const error = Object.assign(new Error('private query details'), { code: '40P01' });
      const f = fixture({ failureMode, error });
      await assert.rejects(f.timed.query('SELECT 1'), (received) => received === error);
      assert.deepEqual(f.released, [error]);
      assert.equal(f.calls.length, 1);
      assert.equal(f.client.listenerCount('error'), 0);
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].failed, true);
      assert.equal(f.events[0].roundTripMs, 30);
      assert.equal(f.events[0].errorCode, '40P01');
    }
  });

  it('does not change query success or failure when logging itself throws', async () => {
    for (const error of [undefined, Object.assign(new Error('SQL failure'), { code: '23514' })]) {
      const f = fixture({ error, timing: { emit() { throw new Error('logger failure'); } } });
      const task = f.timed.query('SELECT 1');
      if (error) await assert.rejects(task, (received) => received === error);
      else assert.equal(await task, f.result);
      assert.deepEqual(f.released, [error]);
    }
  });
});
