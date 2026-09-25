'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runClaimQuery } = require('../src/models/robinhood-head-claim-query');

describe('Robinhood head claim query timing', () => {
  it('separates connection and SQL time and releases the client', async () => {
    const calls = [];
    const database = {
      logSlowQuery: (sql, duration) => calls.push(['slow-log', sql, duration]),
      getClient: async () => {
        calls.push('connect');
        return {
          query: async (sql, params) => {
            calls.push([sql, params]);
            return { rows: [{ id: 1 }] };
          },
          release: () => calls.push('release'),
        };
      },
    };
    const timing = {};

    const result = await runClaimQuery(database, 'SELECT $1', [1], timing);

    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.deepEqual(calls.slice(0, 2), ['connect', ['SELECT $1', [1]]]);
    assert.equal(calls[2][0], 'slow-log');
    assert.equal(calls[2][1], 'SELECT $1');
    assert.ok(calls[2][2] >= 0);
    assert.equal(calls[3], 'release');
    assert.ok(timing.connectionMs >= 0);
    assert.ok(timing.queryMs >= 0);
  });

  it('releases the client when the claim query fails', async () => {
    let released = false;
    const database = {
      getClient: async () => ({
        query: async () => { throw new Error('query failed'); },
        release: () => { released = true; },
      }),
    };
    const timing = {};

    await assert.rejects(runClaimQuery(database, 'SELECT 1', [], timing), /query failed/);
    assert.equal(released, true);
    assert.ok(timing.queryMs >= 0);
  });
});
