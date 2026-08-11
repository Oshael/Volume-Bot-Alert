process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodTokenHolderSummaryRepository,
} = require('../src/models/robinhood-token-holder-summary');
const stage111 = require('../src/utils/db-init-stage111');
const stage112 = require('../src/utils/db-init-stage112');
const stage116 = require('../src/utils/db-init-stage116');
const stage119 = require('../src/utils/db-init-stage119');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'e'.repeat(40)}`;
const repository = createRobinhoodTokenHolderSummaryRepository({ database: db });

async function clearFixture() {
  await db.query(
    `DELETE FROM robinhood_token_holder_daily_snapshots
     WHERE chain = 'robinhood' AND token_address = $1`,
    [TOKEN]
  );
  await db.query(
    `DELETE FROM robinhood_token_holder_summaries
     WHERE chain = 'robinhood' AND token_address = $1`,
    [TOKEN]
  );
}

describe('Robinhood token holder summary repository integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage111.init({ closePool: false });
    await stage112.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage119.init({ closePool: false });
  });

  beforeEach(clearFixture);

  after(async () => {
    await clearFixture();
    await db.pool.end();
  });

  it('preserves the newest success across a failure and an out-of-order response', async () => {
    await repository.recordSuccess({
      tokenAddress: TOKEN,
      holderCount: 5000,
      observedAt: '2026-08-10T03:00:00.000Z',
    });
    await repository.recordFailure({
      tokenAddress: TOKEN,
      errorCode: 'timeout',
      retryAfterAt: '2026-08-10T03:01:00.000Z',
    });
    const stale = await repository.recordSuccess({
      tokenAddress: TOKEN,
      holderCount: 4000,
      observedAt: '2026-08-10T02:59:00.000Z',
    });

    assert.equal(stale.holderCount, 5000);
    assert.equal(stale.observedAt, '2026-08-10T03:00:00.000Z');
    assert.equal(stale.lastErrorCode, 'timeout');
    assert.equal(stale.consecutiveFailures, 1);

    const fresh = await repository.recordSuccess({
      tokenAddress: TOKEN,
      holderCount: 5100,
      observedAt: '2026-08-10T03:02:00.000Z',
    });
    assert.equal(fresh.holderCount, 5100);
    assert.equal(fresh.lastErrorCode, null);
    assert.equal(fresh.consecutiveFailures, 0);
    assert.equal(fresh.retryAfterAt, null);

    const rows = await repository.getSummaries([TOKEN]);
    assert.deepEqual(rows, [fresh]);

    const daily = await repository.listDailySnapshots({
      tokenAddress: TOKEN, days: 2, asOf: '2026-08-10T23:59:59.000Z',
    });
    assert.deepEqual(daily, [{
      date: '2026-08-10', holderCount: 5100,
      observedAt: '2026-08-10T03:02:00.000Z',
    }]);

    const candidates = await repository.listRefreshCandidates({
      asOf: '2026-08-10T04:00:00.000Z',
      hotWindowMs: 3_600_000,
      hotRefreshMs: 300_000,
      coldRefreshMs: 21_600_000,
      limit: 20,
      coldQuota: 5,
    });
    assert.ok(Array.isArray(candidates));
  });

  it('publishes live ledger state through the view and otherwise falls back', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO robinhood_token_holder_summaries (
           chain, token_address, holder_count, source, observed_at, checked_at
         ) VALUES ('robinhood', $1, 5000, 'blockscout',
                   '2026-08-10T03:00:00Z', '2026-08-10T03:00:01Z')`,
        [TOKEN]
      );
      let published = await client.query(
        `SELECT holder_count, source, ledger_version
           FROM robinhood_published_holder_summaries
          WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(published.rows[0], {
        holder_count: '5000', source: 'blockscout', ledger_version: null,
      });

      await client.query(
        `INSERT INTO robinhood_holder_cursors (chain, stream, next_block)
         VALUES ('robinhood', 'live', 1)
         ON CONFLICT (chain, stream) DO NOTHING`
      );
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           chain, token_address, holder_count, ledger_status, version
         ) VALUES ('robinhood', $1, 5100, 'live', 7)`, [TOKEN]
      );
      published = await client.query(
        `SELECT holder_count, source, ledger_version
           FROM robinhood_published_holder_summaries
          WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(published.rows[0], {
        holder_count: '5100', source: 'ledger_live', ledger_version: '7',
      });
      const transactionRepository = createRobinhoodTokenHolderSummaryRepository({
        database: { query: client.query.bind(client) },
      });
      assert.deepEqual(await transactionRepository.syncLiveDailySnapshots({
        asOf: '2026-08-10T23:59:00.000Z', limit: 10,
      }), { savedCount: 1, asOf: '2026-08-10T23:59:00.000Z' });
      await transactionRepository.recordSuccess({
        tokenAddress: TOKEN, holderCount: 9999,
        observedAt: '2026-08-10T23:59:30.000Z',
      });
      const daily = await client.query(
        `SELECT holder_count, source, observed_at
           FROM robinhood_token_holder_daily_snapshots
          WHERE chain = 'robinhood' AND token_address = $1
            AND snapshot_date = '2026-08-10'`,
        [TOKEN]
      );
      assert.deepEqual(daily.rows.map((row) => ({
        holderCount: String(row.holder_count), source: row.source,
        observedAt: row.observed_at.toISOString(),
      })), [{
        holderCount: '5100', source: 'ledger_live',
        observedAt: '2026-08-10T23:59:00.000Z',
      }]);
      await client.query('ROLLBACK');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  });
});
