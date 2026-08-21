const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const express = require('express');
const request = require('supertest');

const holdersRouter = require('../src/routes/robinhood-holders');
const {
  createRobinhoodRouteVisibilityMiddleware,
} = require('../src/middleware/token-chain-visibility');

const TOKEN = `0x${'a'.repeat(40)}`;
const NOW = Date.parse('2026-08-10T05:00:00.000Z');

function cachedSummary(overrides = {}) {
  return {
    tokenAddress: TOKEN,
    holderCount: 4424,
    source: 'blockscout',
    observedAt: '2026-08-10T04:59:00.000Z',
    checkedAt: '2026-08-10T04:59:01.000Z',
    lastErrorCode: null,
    consecutiveFailures: 0,
    retryAfterAt: null,
    ...overrides,
  };
}

function page() {
  return {
    address: TOKEN,
    items: [{
      rank: 1,
      address: `0x${'b'.repeat(40)}`,
      balanceRaw: '5000000000000000000',
      addressType: 'wallet',
      label: null,
      isVerifiedContract: false,
    }],
    hasMore: true,
    nextCursor: 'opaque_cursor',
    source: 'blockscout',
    observedAt: '2026-08-10T05:00:00.000Z',
  };
}

function hourlyBuckets() {
  return Array.from({ length: 169 }, (_, index) => {
    const bucketMs = NOW - ((168 - index) * 3_600_000);
    return {
      bucketStart: new Date(bucketMs).toISOString(), holderCount: 4000 + index,
      source: 'blockscout',
      observedAt: new Date(bucketMs + (index === 168 ? 0 : 1_000)).toISOString(),
    };
  });
}

function appWith(options = {}) {
  const app = express();
  const authenticate = options.authenticate || ((_req, _res, next) => next());
  const visibility = options.visibility || ((_req, _res, next) => next());
  const repository = options.repository || {
    getPublishedSummaries: async () => [cachedSummary()],
    listDailySnapshots: async () => [],
    listHourlyBuckets: async () => [],
    recordSuccess: async () => {},
    recordFailure: async () => {},
  };
  const client = options.client || {
    getTokenHoldersPage: async () => page(),
    getTokenHolderSummary: async () => ({
      available: true, holderCount: 4500, observedAt: new Date(NOW).toISOString(),
    }),
  };
  const scheduler = options.scheduler || {
    schedule: (task) => Promise.resolve().then(task),
  };
  app.use('/api/robinhood', holdersRouter.createRobinhoodHoldersRouter({
    authenticate,
    visibility,
    repository,
    nativeBalanceProvider: options.nativeBalanceProvider,
    holderPageRepository: options.holderPageRepository || {
      listPublishedPage: async () => null,
    },
    holderIntelligenceRepository: options.holderIntelligenceRepository || {
      loadPage: async ({ walletAddresses }) => ({
        classificationVersion: 'rh_holder_v1', classificationStatus: 'unavailable',
        classificationThroughBlock: null, distribution: [],
        holders: walletAddresses.map((address) => ({
          address, tags: [], primaryTag: 'unknown',
          classificationVersion: 'rh_holder_v1',
          classificationStatus: 'unavailable', classifications: [],
        })),
      }),
    },
    client,
    scheduler,
    logger: options.logger || { warn() {} },
    now: () => NOW,
    refreshMs: 300_000,
  }));
  return app;
}

describe('Robinhood holders route', () => {
  it('requires authentication before accessing provider data', async () => {
    let providerCalls = 0;
    const response = await request(appWith({
      authenticate: (_req, res) => res.status(401).json({ error: 'Authentication required' }),
      client: {
        getTokenHoldersPage: async () => { providerCalls += 1; },
        getTokenHolderSummary: async () => { providerCalls += 1; },
      },
    })).get(`/api/robinhood/holders?token=${TOKEN}`);
    const historyResponse = await request(appWith({
      authenticate: (_req, res) => res.status(401).json({ error: 'Authentication required' }),
    })).get(`/api/robinhood/holder-history?token=${TOKEN}`);
    const seriesResponse = await request(appWith({
      authenticate: (_req, res) => res.status(401).json({ error: 'Authentication required' }),
    })).get(`/api/robinhood/holder-count-series?token=${TOKEN}`);

    assert.equal(response.status, 401);
    assert.equal(historyResponse.status, 401);
    assert.equal(seriesResponse.status, 401);
    assert.equal(providerCalls, 0);
  });

  it('rejects the RH-scoped route when Robinhood visibility is disabled', async () => {
    const visibility = createRobinhoodRouteVisibilityMiddleware({
      robinhoodUserVisibility: { enabled: false },
    });
    const response = await request(appWith({ visibility }))
      .get(`/api/robinhood/holders?token=${TOKEN}`);
    const historyResponse = await request(appWith({ visibility }))
      .get(`/api/robinhood/holder-history?token=${TOKEN}`);
    const seriesResponse = await request(appWith({ visibility }))
      .get(`/api/robinhood/holder-count-series?token=${TOKEN}`);

    assert.equal(response.status, 400);
    assert.equal(historyResponse.status, 400);
    assert.equal(seriesResponse.status, 400);
    assert.equal(response.body.code, 'CHAIN_NOT_AVAILABLE');
  });

  it('rejects invalid tokens and cursors before occupying the external scheduler', async () => {
    let scheduled = 0;
    const app = appWith({ scheduler: {
      schedule: () => { scheduled += 1; return Promise.resolve(); },
    } });
    const badToken = await request(app).get('/api/robinhood/holders?token=nope');
    const badCursor = await request(app)
      .get(`/api/robinhood/holders?token=${TOKEN}&cursor=bad!`);

    assert.equal(badToken.status, 400);
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.code, 'INVALID_REQUEST');
    assert.equal(scheduled, 0);
  });

  it('returns daily history from PostgreSQL without occupying the external scheduler', async () => {
    let scheduled = 0;
    const response = await request(appWith({
      repository: {
        listDailySnapshots: async (input) => {
          assert.deepEqual(input, {
            tokenAddress: TOKEN, days: 2, asOf: new Date(NOW).toISOString(),
          });
          return [
            { date: '2026-08-08', holderCount: 4000,
              observedAt: '2026-08-08T23:00:00.000Z' },
            { date: '2026-08-09', holderCount: 4100,
              observedAt: '2026-08-09T23:00:00.000Z' },
            { date: '2026-08-10', holderCount: 4050,
              observedAt: '2026-08-10T04:59:00.000Z' },
          ];
        },
      },
      scheduler: { schedule: () => { scheduled += 1; return Promise.resolve(); } },
    })).get(`/api/robinhood/holder-history?token=${TOKEN}&days=2`);

    assert.equal(response.status, 200);
    assert.equal(response.body.baseline.holderCount, 4000);
    assert.deepEqual(response.body.points.map((point) => ({
      total: point.holderCount, delta: point.delta24h,
    })), [{ total: 4100, delta: 100 }, { total: 4050, delta: -50 }]);
    assert.equal(scheduled, 0);
  });

  it('validates holder-history token and range before reading PostgreSQL', async () => {
    let reads = 0;
    const app = appWith({ repository: {
      listDailySnapshots: async () => { reads += 1; return []; },
    } });
    const badToken = await request(app).get('/api/robinhood/holder-history?token=nope');
    const badDays = await request(app)
      .get(`/api/robinhood/holder-history?token=${TOKEN}&days=91`);

    assert.equal(badToken.status, 400);
    assert.equal(badDays.status, 400);
    assert.equal(reads, 0);
  });

  it('returns the isolated full holder-count series without using the provider', async () => {
    let scheduled = 0;
    const response = await request(appWith({
      repository: {
        listHourlyBuckets: async (input) => {
          assert.deepEqual(input, {
            tokenAddress: TOKEN, asOf: new Date(NOW).toISOString(),
          });
          return hourlyBuckets();
        },
        getPublishedSummaries: async () => [cachedSummary({
          holderCount: 4200, source: 'ledger_live',
          observedAt: '2026-08-10T05:00:00.000Z',
        })],
      },
      scheduler: { schedule: () => { scheduled += 1; return Promise.resolve(); } },
    })).get(`/api/robinhood/holder-count-series?token=${TOKEN}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.resolution, '1h');
    assert.deepEqual(response.body.intervals, ['1h', '4h', '12h', '24h']);
    assert.equal(response.body.series['1h'].length, 169);
    assert.equal(response.body.series['4h'].length, 43);
    assert.equal(response.body.series['12h'].length, 15);
    assert.equal(response.body.series['24h'].length, 8);
    assert.equal(response.body.range.bucketCount, 169);
    assert.equal(response.body.series['1h'].at(-1).status, 'open');
    assert.equal(response.body.deltas['7d'].delta, 200);
    assert.equal(response.body.current.source, 'ledger_live');
    assert.equal(scheduled, 0);
  });

  it('validates and isolates holder-count series failures from the holders page', async () => {
    let reads = 0;
    const app = appWith({ repository: {
      listHourlyBuckets: async () => { reads += 1; throw new Error('database offline'); },
      getPublishedSummaries: async () => [cachedSummary()],
      recordSuccess: async () => {},
      recordFailure: async () => {},
    } });
    const invalid = await request(app).get('/api/robinhood/holder-count-series?token=nope');
    const failed = await request(app).get(`/api/robinhood/holder-count-series?token=${TOKEN}`);
    const holders = await request(app).get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(invalid.status, 400);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, 'HOLDER_COUNT_SERIES_UNAVAILABLE');
    assert.equal(holders.status, 200);
    assert.equal(reads, 1);
  });

  it('returns the normalized page with a fresh cached summary', async () => {
    const response = await request(appWith())
      .get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.token, TOKEN);
    assert.equal(response.body.summary.holderCount, 4424);
    assert.equal(response.body.summary.freshness, 'fresh');
    assert.equal(response.body.holders[0].rank, 1);
    assert.equal(response.body.hasMore, true);
    assert.equal(response.body.nextCursor, 'opaque_cursor');
    assert.equal(response.body.refreshQueued, false);
  });

  it('prefers a published ledger page without occupying the external scheduler', async () => {
    let scheduled = 0;
    const wallet = `0x${'b'.repeat(40)}`;
    const response = await request(appWith({
      nativeBalanceProvider: {
        readBalances: async (addresses) => {
          assert.deepEqual(addresses, [wallet]);
          return { [wallet]: '2500000000000000000' };
        },
      },
      holderPageRepository: {
        listPublishedPage: async (input) => {
          assert.deepEqual(input, { tokenAddress: TOKEN, cursor: null });
          return {
            holderCount: 1, source: 'ledger_live', totalSupplyRaw: '10000',
            observedAt: '2026-08-10T04:59:59.000Z',
            checkedAt: '2026-08-10T05:00:00.000Z',
            items: [{
              rank: 1, address: wallet, balanceRaw: '5000',
              addressType: 'unknown', label: null, isVerifiedContract: false,
              avgBuyMcapUsd: '25000', unrealizedPnlUsd: '100',
            }],
            hasMore: true, nextCursor: 'ledger_v1.next',
          };
        },
      },
      holderIntelligenceRepository: {
        loadPage: async (input) => {
          assert.deepEqual(input, { tokenAddress: TOKEN, walletAddresses: [wallet] });
          return {
            classificationVersion: 'rh_holder_v1', classificationStatus: 'ready',
            classificationThroughBlock: { blockNumber: '199', blockHash: `0x${'1'.repeat(64)}` },
            distribution: [{ metric: 'dev_hold', status: 'ready' }],
            holders: [{
              address: wallet, tags: ['cex'], primaryTag: 'cex',
              classificationVersion: 'rh_holder_v1', classificationStatus: 'ready',
              classifications: [{
                tag: 'cex', confidence: 'deterministic', reasonCode: 'known_cex_address',
              }],
            }],
          };
        },
      },
      scheduler: { schedule: () => { scheduled += 1; return Promise.resolve(); } },
    })).get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.summary.source, 'ledger_live');
    assert.equal(response.body.summary.holderCount, 1);
    assert.equal(response.body.summary.totalSupplyRaw, '10000');
    assert.equal(response.body.holders[0].balanceRaw, '5000');
    assert.equal(response.body.holders[0].avgBuyMcapUsd, '25000');
    assert.equal(response.body.holders[0].unrealizedPnlUsd, '100');
    assert.equal(response.body.holders[0].nativeBalanceRaw, '2500000000000000000');
    assert.deepEqual(response.body.holders[0].tags, ['cex']);
    assert.equal(response.body.holders[0].primaryTag, 'cex');
    assert.equal(response.body.classificationStatus, 'ready');
    assert.equal(response.body.classificationThroughBlock.blockNumber, '199');
    assert.equal(response.body.distribution[0].metric, 'dev_hold');
    assert.equal(response.body.nextCursor, 'ledger_v1.next');
    assert.equal(response.body.refreshQueued, false);
    assert.equal(scheduled, 0);
  });

  it('fails closed when a ledger cursor becomes unavailable', async () => {
    let providerCalls = 0;
    const response = await request(appWith({
      holderPageRepository: { listPublishedPage: async () => null },
      client: {
        getTokenHoldersPage: async () => { providerCalls += 1; },
        getTokenHolderSummary: async () => { providerCalls += 1; },
      },
    })).get(`/api/robinhood/holders?token=${TOKEN}&cursor=ledger_v1.e30`);

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_REQUEST');
    assert.equal(providerCalls, 0);
  });

  it('keeps the holder page available when native balance RPC fails', async () => {
    const warnings = [];
    const response = await request(appWith({
      nativeBalanceProvider: { readBalances: async () => { throw new Error('node offline'); } },
      holderPageRepository: {
        listPublishedPage: async () => ({
          holderCount: 1, source: 'ledger_live', totalSupplyRaw: '10000',
          observedAt: '2026-08-10T04:59:59.000Z', checkedAt: '2026-08-10T05:00:00.000Z',
          items: [{
            rank: 1, address: `0x${'b'.repeat(40)}`, balanceRaw: '5000',
            addressType: 'wallet', label: null, isVerifiedContract: false,
          }],
          hasMore: false, nextCursor: null,
        }),
      },
      logger: { warn: (...args) => warnings.push(args) },
    })).get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.holders[0].nativeBalanceRaw, null);
    assert.equal(warnings[0][0], '[RobinhoodHoldersRoute] native balances unavailable');
  });

  it('keeps the holder page available when intelligence snapshots cannot be read', async () => {
    const warnings = [];
    const response = await request(appWith({
      holderIntelligenceRepository: { loadPage: async () => { throw new Error('schema pending'); } },
      logger: { warn: (...args) => warnings.push(args) },
    })).get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.classificationStatus, 'unavailable');
    assert.deepEqual(response.body.holders[0].tags, []);
    assert.equal(response.body.distribution.length, 8);
    assert.equal(warnings[0][0], '[RobinhoodHoldersRoute] holder intelligence unavailable');
  });

  it('queues a stale first-page summary refresh after prioritizing the page', async () => {
    const calls = [];
    const writes = [];
    const repository = {
      getPublishedSummaries: async () => [cachedSummary({
        observedAt: '2026-08-10T04:00:00.000Z',
        checkedAt: '2026-08-10T04:00:00.000Z',
      })],
      recordSuccess: async (input) => writes.push(input),
      recordFailure: async () => assert.fail('refresh should succeed'),
    };
    const client = {
      getTokenHoldersPage: async () => { calls.push('page'); return page(); },
      getTokenHolderSummary: async () => {
        calls.push('summary');
        return { available: true, holderCount: 4500, observedAt: new Date(NOW).toISOString() };
      },
    };
    const response = await request(appWith({ repository, client }))
      .get(`/api/robinhood/holders?token=${TOKEN}`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.equal(response.body.summary.freshness, 'stale');
    assert.equal(response.body.refreshQueued, true);
    assert.deepEqual(calls, ['page', 'summary']);
    assert.equal(writes[0].holderCount, 4500);
  });

  it('publishes a live ledger count without queuing a Blockscout summary refresh', async () => {
    let summaryCalls = 0;
    const response = await request(appWith({
      repository: {
        getPublishedSummaries: async () => [cachedSummary({
          source: 'ledger_live',
          observedAt: '2026-08-10T04:00:00.000Z',
          checkedAt: '2026-08-10T04:59:59.000Z',
        })],
      },
      client: {
        getTokenHoldersPage: async () => page(),
        getTokenHolderSummary: async () => { summaryCalls += 1; },
      },
    })).get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.summary.source, 'ledger_live');
    assert.equal(response.body.summary.freshness, 'fresh');
    assert.equal(response.body.refreshQueued, false);
    assert.equal(summaryCalls, 0);
  });

  it('does not enqueue another summary refresh while paginating', async () => {
    let summaryCalls = 0;
    const cursor = Buffer.from(JSON.stringify({
      address_hash: `0x${'b'.repeat(40)}`,
      items_count: 50,
      value: '42',
    })).toString('base64url');
    const response = await request(appWith({
      repository: {
        getPublishedSummaries: async () => [cachedSummary({
          observedAt: '2026-08-10T04:00:00.000Z',
          checkedAt: '2026-08-10T04:00:00.000Z',
        })],
        recordSuccess: async () => {},
        recordFailure: async () => {},
      },
      client: {
        getTokenHoldersPage: async () => page(),
        getTokenHolderSummary: async () => { summaryCalls += 1; },
      },
    })).get(`/api/robinhood/holders?token=${TOKEN}&cursor=${cursor}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.refreshQueued, false);
    assert.equal(summaryCalls, 0);
  });

  it('returns a safe 503 and Retry-After without exposing provider details', async () => {
    const providerError = Object.assign(new Error('secret upstream response'), {
      code: 'circuit_open',
      retryAfter: '2.5',
    });
    const response = await request(appWith({
      client: {
        getTokenHoldersPage: async () => { throw providerError; },
        getTokenHolderSummary: async () => ({ available: false }),
      },
    })).get(`/api/robinhood/holders?token=${TOKEN}`);

    assert.equal(response.status, 503);
    assert.equal(response.headers['retry-after'], '3');
    assert.equal(response.body.code, 'HOLDERS_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(response.body), /secret upstream/i);
  });
});
