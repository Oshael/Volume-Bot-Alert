process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage63 = require('../src/utils/db-init-stage63'); // processed_logs (FK parent of observations)
const stage64 = require('../src/utils/db-init-stage64'); // market_observations (MC fallback join)
const stage90 = require('../src/utils/db-init-stage90'); // wallet_swaps (feed source of truth)
const stage109 = require('../src/utils/db-init-stage109'); // swap_mc sidecar (durable MC)
const {
  createRobinhoodWalletSwapRepository,
} = require('../src/models/robinhood-wallet-swap-persistence');
const {
  createRobinhoodWalletSwapReadRepository,
} = require('../src/models/robinhood-wallet-swap-read');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const WALLET = `0x${'1'.repeat(40)}`;
const QUOTE = `0x${'c'.repeat(40)}`;

const writer = createRobinhoodWalletSwapRepository({ database: db });
const reader = createRobinhoodWalletSwapReadRepository({ database: db });

// A swap fixture; `fdvUsd` set => the sidecar (and thus the feed's MC) is populated.
function swap({ block, actionIndex = 0, token = TOKEN_A, minute = 0, fdvUsd = null }) {
  return {
    walletAddress: WALLET,
    transactionHash: `0x${BigInt(block).toString(16).padStart(64, '0')}`,
    actionIndex: String(actionIndex),
    blockNumber: String(block),
    blockTime: `2026-08-06T12:${String(minute).padStart(2, '0')}:00.000Z`,
    protocol: 'uniswap-v3',
    marketKey: 'uniswap-v3:0xpool',
    tokenAddress: token,
    quoteAddress: QUOTE,
    side: 'buy',
    tokenAmountRaw: '1000',
    quoteAmountRaw: '2000',
    tokenDecimals: '18',
    quoteDecimals: '6',
    priceUsd: '0.002',
    volumeUsd: '2500',
    parserVersion: 'rh-swap-1',
    ...(fdvUsd == null ? {} : { fdvUsd, tokenTotalSupplyRaw: '1000000000000000000000000' }),
  };
}

describe('Robinhood wallet-swap trades read model (integration)', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    // Wallet-swap stages are absent from the test schema profile; ensure them here.
    // Order matters: processed_logs is the FK parent of market_observations.
    await stage63.init({ closePool: false });
    await stage64.init({ closePool: false });
    await stage90.init({ closePool: false });
    await stage109.init({ closePool: false });
  });

  beforeEach(async () => {
    await db.query("DELETE FROM robinhood_swap_mc WHERE chain = 'robinhood'");
    await db.query('DELETE FROM robinhood_wallet_swaps');
  });

  after(async () => {
    await db.pool.end();
  });

  it('filters by token, reads MC from the sidecar (null when absent), newest first', async () => {
    await writer.insertWalletSwaps([
      swap({ block: 100, minute: 10, fdvUsd: '48000' }), // has MC -> sidecar
      swap({ block: 101, minute: 20 }), // no MC -> null
      swap({ block: 102, minute: 30, fdvUsd: '52000' }), // has MC -> sidecar, newest
      swap({ block: 200, minute: 40, token: TOKEN_B, fdvUsd: '9000' }), // other token -> excluded
    ]);

    const page = await reader.getRecentTrades({ tokenAddress: TOKEN_A, limit: 50 });

    assert.equal(page.token, TOKEN_A);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    // TOKEN_B is filtered out; TOKEN_A returned newest-first (block 102, 101, 100).
    assert.deepEqual(page.trades.map((t) => t.blockNumber), [102, 101, 100]);
    assert.deepEqual(page.trades.map((t) => t.mcUsd), [52000, null, 48000]);
    assert.equal(page.trades[0].amountUsd, 2500);
    assert.equal(page.trades[0].side, 'buy');
    assert.equal(page.trades[0].walletAddress, WALLET);
  });

  it('walks keyset pages across a partition boundary without overlap or skips', async () => {
    // Five swaps spanning two UTC days (the daily-partitioned table), all with MC.
    await writer.insertWalletSwaps([
      swap({ block: 300, minute: 10, fdvUsd: '10000' }),
      swap({ block: 301, minute: 20, fdvUsd: '11000' }),
      swap({ block: 302, minute: 30, fdvUsd: '12000' }),
      {
        ...swap({ block: 303, fdvUsd: '13000' }),
        blockTime: '2026-08-07T00:05:00.000Z', // next UTC day -> next partition
      },
      {
        ...swap({ block: 304, fdvUsd: '14000' }),
        blockTime: '2026-08-07T00:10:00.000Z',
      },
    ]);

    const seen = [];
    let cursor;
    let pages = 0;
    for (;;) {
      const page = await reader.getRecentTrades({ tokenAddress: TOKEN_A, cursor, limit: 2 });
      seen.push(...page.trades.map((t) => t.blockNumber));
      pages += 1;
      if (!page.hasMore) { assert.equal(page.nextCursor, null); break; }
      assert.ok(page.nextCursor);
      cursor = page.nextCursor;
      assert.ok(pages < 10, 'pagination must terminate');
    }

    assert.equal(pages, 3); // 2 + 2 + 1
    // Every swap seen exactly once, strictly newest-first across the boundary.
    assert.deepEqual(seen, [304, 303, 302, 301, 300]);
    assert.equal(new Set(seen).size, 5);
  });
});
