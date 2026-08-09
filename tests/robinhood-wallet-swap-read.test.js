const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodWalletSwapReadRepository,
  __private,
} = require('../src/models/robinhood-wallet-swap-read');

const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';

function row(overrides = {}) {
  return {
    transaction_hash: `0x${'a'.repeat(64)}`,
    action_index: '7',
    block_number: '29000001',
    block_time: '2026-08-06T12:00:00.000Z',
    side: 'buy',
    wallet_address: '0x1111111111111111111111111111111111111111',
    volume_usd: '1234.5',
    price_usd: '0.002',
    mc_usd: '987654.3',
    ...overrides,
  };
}

function fakeDatabase(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

describe('Robinhood wallet-swap trades read model', () => {
  it('reads MC from the durable sidecar, falling back to the live observation', () => {
    // Both LEFT JOINs on the attribution key (action_index = log_index); the
    // durable robinhood_swap_mc wins, the observation is the pre-backfill fallback.
    // LEFT (not INNER) so a swap with no MC yet surfaces null instead of vanishing.
    assert.match(__private.RECENT_TRADES_SQL, /LEFT JOIN robinhood_swap_mc mc/);
    assert.match(__private.RECENT_TRADES_SQL, /mc\.log_index = swap\.action_index/);
    assert.match(__private.RECENT_TRADES_SQL, /LEFT JOIN robinhood_market_observations/);
    assert.match(__private.RECENT_TRADES_SQL, /observation\.log_index = swap\.action_index/);
    assert.match(
      __private.RECENT_TRADES_SQL,
      /COALESCE\(mc\.fdv_usd, observation\.fdv_usd\) AS mc_usd/,
    );
  });

  it('orders by the token_time index prefix with a stable keyset tie-break', () => {
    assert.match(
      __private.RECENT_TRADES_SQL,
      /ORDER BY swap\.block_time DESC, swap\.block_number DESC, swap\.action_index DESC/,
    );
    assert.match(
      __private.RECENT_TRADES_SQL,
      /\(swap\.block_time, swap\.block_number, swap\.action_index\)\s*<\s*\(\$2::timestamptz, \$3::bigint, \$4::bigint\)/,
    );
    assert.match(__private.RECENT_TRADES_SQL, /\$2::timestamptz IS NULL/);
    assert.match(__private.RECENT_TRADES_SQL, /\$6::varchar IS NULL OR swap\.wallet_address = \$6/);
  });

  it('normalizes a swap row into the feed contract (buy/sell, amount, MC, nulls)', () => {
    const buy = __private.normalizeTrade(row());
    assert.equal(buy.side, 'buy');
    assert.equal(buy.amountUsd, 1234.5);
    assert.equal(buy.mcUsd, 987654.3);
    assert.equal(buy.priceUsd, 0.002);
    assert.equal(buy.actionIndex, 7);
    assert.equal(buy.blockNumber, 29000001);
    assert.equal(buy.blockTime, '2026-08-06T12:00:00.000Z');

    const sellNoMc = __private.normalizeTrade(row({ side: 'sell', mc_usd: null, volume_usd: null }));
    assert.equal(sellNoMc.side, 'sell');
    assert.equal(sellNoMc.mcUsd, null);
    assert.equal(sellNoMc.amountUsd, null);
  });

  it('defaults and bounds the limit, rejecting out-of-range values', () => {
    assert.equal(__private.normalizeQuery({ tokenAddress: TOKEN }).limit, __private.DEFAULT_LIMIT);
    assert.equal(__private.normalizeQuery({ tokenAddress: TOKEN, limit: '10' }).limit, 10);
    assert.throws(() => __private.normalizeLimit('0'), /limit must be between/);
    assert.throws(() => __private.normalizeLimit(String(__private.MAX_LIMIT + 1)), /limit must be between/);
    assert.equal(__private.normalizeScope(undefined), 'all');
    assert.equal(__private.normalizeScope('DEV'), 'dev');
    assert.throws(() => __private.normalizeScope('tracked'), (err) => err.code === 'INVALID_SCOPE');
  });

  it('round-trips the keyset cursor and rejects a malformed one', () => {
    const cursor = __private.encodeCursor({
      blockTime: '2026-08-06T12:00:00.000Z', blockNumber: 29000001, actionIndex: 7,
    });
    const decoded = __private.decodeCursor(cursor);
    assert.equal(decoded.blockNumber, 29000001);
    assert.equal(decoded.actionIndex, 7);
    assert.equal(decoded.blockTime.toISOString(), '2026-08-06T12:00:00.000Z');
    assert.equal(__private.decodeCursor(null), null);
    assert.throws(
      () => __private.decodeCursor(Buffer.from('nope', 'utf8').toString('base64url')),
      (err) => err.code === 'INVALID_CURSOR',
    );
  });

  it('first page passes a null cursor and reports hasMore via the limit+1 probe', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => row({ action_index: String(index) }));
    const database = fakeDatabase(rows);
    const repository = createRobinhoodWalletSwapReadRepository({ database });

    const page = await repository.getRecentTrades({ tokenAddress: TOKEN, limit: 2 });
    assert.equal(database.calls[0].params[0], TOKEN);
    assert.equal(database.calls[0].params[1], null); // no cursor block_time
    assert.equal(database.calls[0].params[4], 3); // limit + 1
    assert.equal(database.calls[0].params[5], null); // all scope has no wallet filter
    assert.equal(page.trades.length, 2);
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
    // The cursor points at the last returned trade, not the probe row.
    assert.deepEqual(__private.decodeCursor(page.nextCursor).actionIndex, 1);
  });

  it('a follow-up page forwards the decoded cursor tuple and ends without a next cursor', async () => {
    const database = fakeDatabase([row()]);
    const repository = createRobinhoodWalletSwapReadRepository({ database });
    const cursor = __private.encodeCursor({
      blockTime: '2026-08-06T12:00:00.000Z', blockNumber: 29000005, actionIndex: 2,
    });

    const page = await repository.getRecentTrades({ tokenAddress: TOKEN, cursor, limit: 50 });
    // block_time is forwarded as a Date (pg binds it to timestamptz).
    assert.ok(database.calls[0].params[1] instanceof Date);
    assert.equal(database.calls[0].params[1].toISOString(), '2026-08-06T12:00:00.000Z');
    assert.equal(database.calls[0].params[2], '29000005');
    assert.equal(database.calls[0].params[3], '2');
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.equal(page.token, TOKEN);
    assert.equal(page.scope, 'all');
    assert.equal(page.creatorAddress, null);
  });

  it('resolves DEV once and filters trades by the direct contract creator', async () => {
    const calls = [];
    const creator = '0x2222222222222222222222222222222222222222';
    const database = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql === __private.CREATOR_SQL) return { rows: [{ creator_address: creator }] };
        return { rows: [row({ wallet_address: creator })] };
      },
    };
    const repository = createRobinhoodWalletSwapReadRepository({ database });

    const page = await repository.getRecentTrades({ tokenAddress: TOKEN, scope: 'dev' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params[5], creator);
    assert.equal(page.scope, 'dev');
    assert.equal(page.creatorAddress, creator);
    assert.equal(page.trades[0].walletAddress, creator);
  });

  it('returns an empty DEV page without scanning swaps when creator is unresolved', async () => {
    const database = fakeDatabase([]);
    const repository = createRobinhoodWalletSwapReadRepository({ database });
    const page = await repository.getRecentTrades({ tokenAddress: TOKEN, scope: 'dev' });

    assert.equal(database.calls.length, 1);
    assert.equal(page.creatorAddress, null);
    assert.deepEqual(page.trades, []);
  });
});
