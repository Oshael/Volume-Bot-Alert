const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  __private: { parseCliArgs, runBackfill, INSERT_SQL, DELETE_SQL },
} = require('../src/utils/backfill-robinhood-market-buckets-1m');

const WINDOW = { start_ts: '2026-08-03T11:49:00.000Z', end_ts: '2026-08-03T17:50:00.000Z' };

function fakeDatabase({ withWindow = true } = {}) {
  const client = {
    queries: [],
    released: false,
    async query(sql, params) {
      this.queries.push({ sql: String(sql), params });
      return { rowCount: 3 };
    },
    release() { this.released = true; },
  };
  const database = {
    queries: [],
    client,
    clientRequested: 0,
    async query(sql, params) {
      const text = String(sql);
      this.queries.push({ sql: text, params });
      if (text.includes('date_trunc(\'minute\', MIN(observed_at))')) {
        return { rows: [withWindow ? WINDOW : { start_ts: null, end_ts: null }] };
      }
      return { rows: [{ minutes: '361', buckets: '540', volume_usd: '12345.67' }] };
    },
    async getClient() { this.clientRequested += 1; return client; },
  };
  return database;
}

describe('backfill-robinhood-market-buckets-1m CLI parsing', () => {
  it('defaults to dry-run and requires from-block', () => {
    assert.throws(() => parseCliArgs([]), /--from-block .* is required/);
    const parsed = parseCliArgs(['--from-block', '26738684']);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.fromBlock, 26738684);
    assert.equal(parsed.toBlock, null);
  });

  it('rejects an out-of-order block window and an invalid mode', () => {
    assert.throws(
      () => parseCliArgs(['--from-block', '100', '--to-block', '100']),
      /--to-block must be greater/
    );
    assert.throws(() => parseCliArgs(['--from-block', '1', '--mode', 'delete']), /mode must be/);
  });

  it('requires an explicit upper block bound for writes', () => {
    assert.throws(
      () => parseCliArgs(['--from-block', '1', '--mode', 'write']),
      /write mode requires --to-block/
    );
    assert.equal(parseCliArgs([
      '--from-block', '1', '--to-block', '100', '--mode', 'write',
    ]).toBlock, 100);
  });
});

describe('backfill-robinhood-market-buckets-1m execution', () => {
  it('dry-run reports the window without opening a write transaction', async () => {
    const database = fakeDatabase();
    const summary = await runBackfill({ mode: 'dry-run', fromBlock: 26738684, toBlock: null }, { database });

    assert.equal(database.clientRequested, 0);
    assert.equal(summary.minutes, 361);
    assert.equal(summary.buckets, 540);
    assert.equal(summary.volumeUsd, '12345.67');
    assert.deepEqual(summary.window, { start: WINDOW.start_ts, end: WINDOW.end_ts });
  });

  it('write mode deletes and rebuilds the window in one transaction', async () => {
    const database = fakeDatabase();
    const summary = await runBackfill({ mode: 'write', fromBlock: 26738684, toBlock: null }, { database });

    const steps = database.client.queries.map((entry) => entry.sql.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepEqual(steps, ['BEGIN', 'DELETE FROM', 'INSERT INTO', 'COMMIT']);
    // DELETE and INSERT both run over the resolved [start, end) window.
    for (const entry of database.client.queries) {
      if (entry.sql.startsWith('BEGIN') || entry.sql.startsWith('COMMIT')) continue;
      assert.deepEqual(entry.params, [WINDOW.start_ts, WINDOW.end_ts]);
    }
    assert.equal(database.client.released, true);
    assert.equal(summary.deleted, 3);
    assert.equal(summary.inserted, 3);
  });

  it('rebuild is scoped to the robinhood chain and accepted observations only', () => {
    assert.match(DELETE_SQL, /FROM robinhood_market_buckets_1m/);
    assert.match(DELETE_SQL, /chain = 'robinhood'/);
    assert.match(INSERT_SQL, /INSERT INTO robinhood_market_buckets_1m/);
    assert.match(INSERT_SQL, /FROM robinhood_market_observations/);
    assert.match(INSERT_SQL, /status = 'accepted'/);
    assert.match(INSERT_SQL, /SUM\(volume_usd\)/);
  });

  it('does nothing when no observations fall past the halted block', async () => {
    const database = fakeDatabase({ withWindow: false });
    const summary = await runBackfill({ mode: 'write', fromBlock: 99999999, toBlock: null }, { database });

    assert.equal(database.clientRequested, 0);
    assert.equal(summary.window, null);
    assert.equal(summary.buckets, 0);
  });
});
