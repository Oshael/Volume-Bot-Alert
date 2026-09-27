const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const express = require('express');
const request = require('supertest');
const tradesRouter = require('../src/routes/robinhood-trades');
const {
  createRobinhoodWalletTradeReadRepository,
  __private,
} = require('../src/models/robinhood-wallet-trade-read');

const WALLET = `0x${'1'.repeat(40)}`;
const TOKEN = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;

function row(overrides = {}) {
  return {
    wallet_address: WALLET, token_address: TOKEN, transaction_hash: HASH,
    action_index: '7', block_number: '29000001',
    block_time: '2026-08-06T12:00:00.000Z', side: 'buy',
    token_amount: '123456789.123456789', token_amount_raw: '123456789123456789',
    token_decimals: 9, volume_usd: null, price_usd: null,
    ...overrides,
  };
}

describe('Robinhood wallet trade feed', () => {
  it('uses wallet index order, bounds pages, and preserves decimal quantity', async () => {
    const calls = [];
    const database = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [row(), row({ action_index: '6' }), row({ action_index: '5' })] };
      },
    };
    const repository = createRobinhoodWalletTradeReadRepository({ database });
    const page = await repository.getWalletTrades({ walletAddress: WALLET, limit: 2 });

    assert.match(__private.WALLET_TRADES_SQL, /swap\.wallet_address = \$1/);
    assert.match(__private.WALLET_TRADES_SQL, /swap\.transaction_hash DESC/);
    assert.equal(calls[0].params[0], WALLET);
    assert.equal(calls[0].params[1], null);
    assert.equal(calls[0].params[6], 3);
    assert.equal(page.trades.length, 2);
    assert.equal(page.trades[0].tokenAmount, '123456789.123456789');
    assert.equal(page.trades[0].amountUsd, null);
    assert.equal(page.hasMore, true);

    await repository.getWalletTrades({
      walletAddress: WALLET, cursor: page.nextCursor, side: 'all', limit: 2,
    });
    assert.equal(calls[1].params[4], '6');
    assert.equal(calls[1].params[5], HASH);
  });

  it('rejects invalid filters and cursors from another wallet or side', async () => {
    const repository = createRobinhoodWalletTradeReadRepository({
      database: { query: async () => ({ rows: [] }) },
    });
    const cursor = __private.encodeCursor(WALLET, 'buy', {
      blockTime: '2026-08-06T12:00:00.000Z', blockNumber: 1,
      actionIndex: 0, transactionHash: HASH,
    });
    await assert.rejects(
      repository.getWalletTrades({ walletAddress: WALLET, side: 'sell', cursor }),
      (error) => error.code === 'INVALID_CURSOR',
    );
    await assert.rejects(
      repository.getWalletTrades({ walletAddress: WALLET, side: 'tracked' }),
      (error) => error.code === 'INVALID_SIDE',
    );
    await assert.rejects(
      repository.getWalletTrades({ walletAddress: WALLET, limit: 101 }),
      (error) => error.code === 'INVALID_LIMIT',
    );
    await assert.rejects(
      repository.getWalletTrades({ walletAddress: WALLET, cursor: 'bad!' }),
      (error) => error.code === 'INVALID_CURSOR',
    );
  });

  it('keeps auth and visibility gates on the wallet route', async () => {
    let reads = 0;
    const walletRepository = {
      getWalletTrades: async (input) => {
        if (input.side === 'invalid') {
          const error = new Error('side must be all, buy or sell');
          error.code = 'INVALID_SIDE';
          throw error;
        }
        reads += 1;
        return { chain: 'robinhood', wallet: WALLET, side: 'all', trades: [], hasMore: false, nextCursor: null };
      },
    };
    const authenticate = (req, res, next) => (req.get('Authorization') ? next() : res.sendStatus(401));
    const visibility = (req, res, next) => (req.get('X-Hidden') ? res.sendStatus(400) : next());
    const app = express();
    app.use('/api/robinhood', tradesRouter.createRobinhoodTradesRouter({
      walletRepository, authenticate, visibility,
    }));

    await request(app).get(`/api/robinhood/wallet-trades?wallet=${WALLET}`).expect(401);
    await request(app).get(`/api/robinhood/wallet-trades?wallet=${WALLET}`)
      .set('Authorization', 'test').set('X-Hidden', '1').expect(400);
    await request(app).get('/api/robinhood/wallet-trades?wallet=invalid')
      .set('Authorization', 'test').expect(400);
    await request(app).get(`/api/robinhood/wallet-trades?wallet=${WALLET}&side=invalid`)
      .set('Authorization', 'test').expect(400);
    const response = await request(app).get(`/api/robinhood/wallet-trades?wallet=${WALLET}`)
      .set('Authorization', 'test').expect(200);
    assert.equal(response.body.wallet, WALLET);
    assert.equal(reads, 1);
  });
});
