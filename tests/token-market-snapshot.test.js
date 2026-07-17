const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const tokenMarketSnapshot = require('../src/models/token-market-snapshot');

describe('legacy token market snapshots', () => {
  it('rejects Robinhood across every public operation before querying the database', async () => {
    const originalQuery = db.query;
    let queryCount = 0;
    db.query = async () => {
      queryCount += 1;
      throw new Error('database should not be queried');
    };
    const evmAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const calls = [
      () => tokenMarketSnapshot.insertSnapshot({ chain: 'robinhood', tokenAddress: evmAddress }),
      () => tokenMarketSnapshot.listRecentByAddress(evmAddress, 10, { chain: 'robinhood' }),
      () => tokenMarketSnapshot.listHistoryByAddress(evmAddress, { chain: 'robinhood' }),
      () => tokenMarketSnapshot.listLatestByAddresses([evmAddress], 2, { chain: 'robinhood' }),
      () => tokenMarketSnapshot.listCurrentAndBaselineByAddresses(
        [evmAddress], 5, { chain: 'robinhood' }
      ),
      () => tokenMarketSnapshot.deleteByAddresses([evmAddress], { chain: 'robinhood' }),
    ];

    try {
      for (const call of calls) {
        await assert.rejects(
          call,
          (error) => error?.code === 'NON_SOLANA_LEGACY_MARKET_SNAPSHOT_DISABLED'
        );
      }
      assert.equal(queryCount, 0);
    } finally {
      db.query = originalQuery;
    }
  });

  it('preserves the legacy default as explicit Solana behavior', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ token_address: params[0] }], rowCount: 1 };
    };

    try {
      const row = await tokenMarketSnapshot.insertSnapshot({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        ts: '2026-07-13T12:00:00.000Z',
        mcap: 100000,
      });
      assert.equal(row.token_address, 'So11111111111111111111111111111111111111112');
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /INSERT INTO token_market_snapshots/);
    } finally {
      db.query = originalQuery;
    }
  });
});
