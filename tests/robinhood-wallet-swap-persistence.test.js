const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSwapRepository,
  __private: { normalizeSwapRow, partitionName, dayBounds, partitionDayKey },
} = require('../src/models/robinhood-wallet-swap-persistence');

function validRow(overrides = {}) {
  return {
    walletAddress: `0x${'a'.repeat(40)}`,
    transactionHash: `0x${'1'.repeat(64)}`,
    actionIndex: '3',
    blockNumber: '12000000',
    blockTime: '2026-07-31T23:30:00.000Z',
    protocol: 'uniswap-v3',
    marketKey: 'uniswap-v3:0xpool',
    tokenAddress: `0x${'b'.repeat(40)}`,
    quoteAddress: `0x${'c'.repeat(40)}`,
    side: 'buy',
    tokenAmountRaw: '1000',
    quoteAmountRaw: '2000',
    tokenDecimals: '18',
    quoteDecimals: '6',
    priceUsd: '1.25',
    volumeUsd: '2500',
    parserVersion: 'rh-swap-1',
    ...overrides,
  };
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: /^INSERT/.test(sql.trim()) ? 1 : 0 };
    },
  };
}

describe('robinhood wallet swap persistence', () => {
  it('derives UTC daily partition names and bounds', () => {
    assert.equal(partitionDayKey(new Date('2026-07-31T23:59:59.000Z')), '2026-07-31');
    assert.equal(partitionName('2026-07-31'), 'robinhood_wallet_swaps_2026_07_31');
    assert.deepEqual(dayBounds('2026-07-31'), {
      from: '2026-07-31T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
    assert.throws(() => partitionName('2026-7-31'), /YYYY-MM-DD/);
  });

  it('normalizes a swap row and derives its partition day', () => {
    const row = normalizeSwapRow(validRow());
    assert.equal(row.wallet_address, `0x${'a'.repeat(40)}`);
    assert.equal(row.side, 'buy');
    assert.equal(row.__dayKey, '2026-07-31');
    assert.equal(row.token_decimals, '18');
    assert.equal(row.router_address, null); // optional field omitted -> null
    assert.equal(row.volume_usd, '2500');
  });

  it('rejects malformed rows', () => {
    assert.throws(() => normalizeSwapRow(validRow({ walletAddress: '0xnothex' })), /walletAddress/);
    assert.throws(() => normalizeSwapRow(validRow({ tokenAmountRaw: '0' })), /greater than zero/);
    assert.throws(() => normalizeSwapRow(validRow({ side: 'hold' })), /side must be one of/);
    assert.throws(() => normalizeSwapRow(validRow({ protocol: 'sushi' })), /protocol must be one of/);
    assert.throws(() => normalizeSwapRow(validRow({ blockTime: 'not-a-date' })), /valid timestamp/);
  });

  it('creates each day partition before inserting, then upserts idempotently', async () => {
    const database = fakeDb();
    const repo = createRobinhoodWalletSwapRepository({ database });
    // two rows spanning two UTC days, given out of order
    const result = await repo.insertWalletSwaps([
      validRow({ blockTime: '2026-08-01T00:10:00.000Z', transactionHash: `0x${'2'.repeat(64)}` }),
      validRow({ blockTime: '2026-07-31T23:30:00.000Z' }),
    ]);

    const partitionCalls = database.calls.filter((c) => /PARTITION OF/.test(c.sql));
    const insertCalls = database.calls.filter((c) => /^INSERT/.test(c.sql.trim()));

    // partitions ensured first, in sorted day order
    assert.deepEqual(partitionCalls.map((c) => c.sql.match(/robinhood_wallet_swaps_\d{4}_\d{2}_\d{2}/)[0]), [
      'robinhood_wallet_swaps_2026_07_31',
      'robinhood_wallet_swaps_2026_08_01',
    ]);
    assert.equal(insertCalls.length, 1);
    // insert happens after both partitions
    assert.ok(database.calls.indexOf(insertCalls[0]) > database.calls.indexOf(partitionCalls[1]));
    assert.match(insertCalls[0].sql, /ON CONFLICT \(chain, transaction_hash, action_index, block_time\) DO NOTHING/);
    // payload carries the chain and both rows
    const payload = JSON.parse(insertCalls[0].params[0]);
    assert.equal(payload.length, 2);
    assert.ok(payload.every((row) => row.chain === 'robinhood'));
    assert.equal(result.inserted, 1);
    assert.deepEqual(result.ensuredDays, ['2026-07-31', '2026-08-01']);
  });

  it('is a no-op for an empty batch', async () => {
    const database = fakeDb();
    const repo = createRobinhoodWalletSwapRepository({ database });
    const result = await repo.insertWalletSwaps([]);
    assert.equal(database.calls.length, 0);
    assert.deepEqual(result, { inserted: 0, ensuredDays: [] });
  });
});
