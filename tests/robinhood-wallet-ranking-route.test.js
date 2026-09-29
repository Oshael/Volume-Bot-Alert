const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const express = require('express');
const request = require('supertest');
const rankingRouter = require('../src/routes/robinhood-wallet-ranking');
const {
  createRobinhoodWalletRankingPage,
} = require('../src/services/robinhood-wallet-ranking-page');

const AS_OF = '2026-09-27T12:00:00.000Z';
const address = (number) => `0x${number.toString(16).padStart(40, '0')}`;

function ranking(overrides = {}) {
  return { window: 'ALL', asOf: AS_OF, windowStart: null,
    coverage: 'complete', rankingIsComplete: true, rankingReady: true,
    reasons: [], candidateWalletCount: 3, excludedWalletCount: 0,
    ranked: [1, 2, 3].map((rank) => ({ rank, walletAddress: address(rank),
      gainUsd: String(40 - rank * 10), openPositionCount: rank })),
    ...overrides };
}

function harness(options = {}) {
  const calls = [];
  let current = ranking();
  let latest = AS_OF;
  const page = createRobinhoodWalletRankingPage({
    rankingService: { async getRanking(input) {
      calls.push(input);
      if (options.rankingError) throw options.rankingError;
      return current;
    } },
    frontierRepository: { async latestAsOf(version) {
      assert.equal(version, 'unified_transfer_v1');
      return latest;
    } },
    profileRepository: { async findByWalletAddresses(wallets) {
      if (options.profileError) throw options.profileError;
      return wallets.includes(address(1)) ? [{ address: address(1),
        platform: 'fomo', displayName: 'Trader' }] : [];
    } },
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use('/api/robinhood', rankingRouter.createRobinhoodWalletRankingRouter({
    page, authenticate: (req, res, next) => (req.get('Authorization')
      ? next() : res.sendStatus(401)),
    visibility: (req, res, next) => (req.get('X-Hidden')
      ? res.sendStatus(400) : next()),
    logger: { error() {} },
  }));
  return { app, calls, setRanking(value) { current = value; },
    setLatest(value) { latest = value; } };
}

describe('Robinhood Top Wallets HTTP contract', () => {
  it('authenticates, isolates Robinhood, paginates stable order and adds optional profile', async () => {
    const { app, calls } = harness();
    const url = '/api/robinhood/top-wallets?window=ALL&limit=2';
    await request(app).get(url).expect(401);
    await request(app).get(url).set('Authorization', 'test')
      .set('X-Hidden', '1').expect(400);
    await request(app).get(`${url}&chain=solana`)
      .set('Authorization', 'test').expect(400);
    assert.equal(calls.length, 0);

    const first = await request(app).get(url).set('Authorization', 'test').expect(200);
    assert.equal(first.body.chainKey, 'robinhood');
    assert.equal(first.body.asOf, AS_OF);
    assert.equal(first.body.coverage, 'complete');
    assert.equal(first.body.rankingLimit, 100);
    assert.equal(first.body.rankingListTruncated, false);
    assert.deepEqual(first.body.items.map((item) => item.walletAddress),
      [address(1), address(2)]);
    assert.equal(first.body.items[0].profile.displayName, 'Trader');
    assert.equal(first.body.items[1].profile, null);
    assert.equal(first.body.hasMore, true);
    assert.equal(calls[0].projectionVersion, 'unified_transfer_v1');
    assert.equal(calls[0].classificationVersion, 'rh_transfer_v1');
    assert.equal(calls[0].limit, 100);

    const next = await request(app).get(`${url}&cursor=${first.body.nextCursor}`)
      .set('Authorization', 'test').expect(200);
    assert.deepEqual(next.body.items.map((item) => item.rank), [3]);
    assert.equal(next.body.hasMore, false);
    assert.equal(next.body.nextCursor, null);
  });

  it('rejects stale and malformed cursors rather than skipping or duplicating wallets', async () => {
    const { app, setRanking } = harness();
    const url = '/api/robinhood/top-wallets?window=ALL&limit=1';
    const first = await request(app).get(url).set('Authorization', 'test').expect(200);
    await request(app).get(`${url}&cursor=bad!`)
      .set('Authorization', 'test').expect(400);
    await request(app).get(`${url}&cursor=${first.body.nextCursor}&asOf=2020-01-01`)
      .set('Authorization', 'test').expect(400);
    setRanking(ranking({ ranked: ranking().ranked.map((row) => (
      row.rank === 1 ? { ...row, gainUsd: '31' } : row
    )) }));
    const stale = await request(app).get(`${url}&cursor=${first.body.nextCursor}`)
      .set('Authorization', 'test').expect(409);
    assert.equal(stale.body.code, 'STALE_RANKING_CURSOR');
  });

  it('preserves partial coverage when profile lookup fails', async () => {
    const { app, setRanking } = harness({ profileError: new Error('profile down') });
    setRanking(ranking({ coverage: 'partial', rankingIsComplete: false,
      rankingReady: false, reasons: ['window_events_incomplete'],
      excludedWalletCount: 1, ranked: ranking().ranked.slice(0, 1) }));
    const response = await request(app)
      .get('/api/robinhood/top-wallets?window=ALL')
      .set('Authorization', 'test').expect(200);
    assert.equal(response.body.coverage, 'partial');
    assert.equal(response.body.excludedWalletCount, 1);
    assert.deepEqual(response.body.reasons, ['window_events_incomplete']);
    assert.equal(response.body.profileStatus, 'unavailable');
    assert.equal(response.body.items[0].profile, null);
  });

  it('does not infer top-100 completeness from a capped candidate universe', async () => {
    const { app, setRanking } = harness();
    setRanking(ranking({ coverage: 'partial', rankingIsComplete: false,
      candidateUniverseComplete: false, candidateWalletCount: 1000,
      reasons: ['candidate_universe_limit_reached'], ranked: [] }));
    const response = await request(app)
      .get('/api/robinhood/top-wallets?window=ALL')
      .set('Authorization', 'test').expect(200);
    assert.deepEqual(response.body.items, []);
    assert.equal(response.body.rankingListTruncated, null);
  });

  it('returns controlled status for a missing checkpoint and ranking failure', async () => {
    const unavailable = harness();
    unavailable.setLatest(null);
    const url = '/api/robinhood/top-wallets?window=ALL';
    const absent = await request(unavailable.app).get(url)
      .set('Authorization', 'test').expect(503);
    assert.equal(absent.body.code, 'RANKING_NOT_READY');
    const failed = harness({ rankingError: new Error('database down') });
    const response = await request(failed.app).get(url)
      .set('Authorization', 'test').expect(500);
    assert.equal(response.body.code, 'RANKING_READ_FAILED');
  });
});
