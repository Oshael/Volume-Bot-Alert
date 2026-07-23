const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const gmgnCatalogIngestion = require('../src/services/gmgn-catalog-ingestion');
const gmgnRiskReviewQueue = require('../src/services/gmgn-risk-review-queue');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function createTokenCatalogStub() {
  const calls = [];
  return {
    calls,
    async getByAddress(address) {
      calls.push(['getByAddress', address]);
      return {
        address,
        source: 'dexscreener-discovery',
        eligibility_state: 'dex-high',
        eligible_for_monitoring: true,
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_vol_5m: 10000,
      };
    },
    async upsertToken(payload) {
      calls.push(['upsertToken', payload]);
      return {
        address: payload.address,
        source: payload.source,
      };
    },
    async applyEvaluationResult(address, payload) {
      calls.push(['applyEvaluationResult', address, payload]);
      return {
        address,
        source: 'gmgn',
        eligible_for_monitoring: payload.eligibleForMonitoring,
        eligibility_state: payload.eligibilityState,
        monitor_priority: payload.monitorPriority,
        last_mcap: payload.mcap,
        last_vol_5m: payload.vol5m,
        last_vol_24h: payload.vol24h,
      };
    },
  };
}

function createSnapshot(address = TOKEN_A) {
  return {
    address,
    chain: 'sol',
    symbol: 'SOL',
    name: 'Wrapped SOL',
    pairAddress: 'pair-not-base58',
    pairUrl: 'https://gmgn.ai/sol/token/So11111111111111111111111111111111111111112',
    imageUrl: 'https://img.example/sol.png',
    mcap: 250000,
    price: 0.25,
    vol1m: 4000,
    vol5m: 18000,
    vol1h: 50000,
    vol6h: 120000,
    vol24h: 350000,
    priceChange1h: 12,
    priceChange6h: 25,
    priceChange24h: 80,
    liquidityUsd: 90000,
    tokenCreatedAt: '2026-05-03T06:00:00.000Z',
    gmgnInterval: '5m',
  };
}

function createHighConfidenceJunkSnapshot(address = TOKEN_A) {
  return {
    ...createSnapshot(address),
    mcap: 500000,
    vol1h: 50,
    vol6h: 1000,
    vol24h: 1000,
    liquidityUsd: 100,
    priceChange6h: 70,
    priceChange24h: 140,
    gmgnInterval: '5m',
    gmgnIntervals: ['5m'],
  };
}

function createMediumConfidenceJunkSnapshot(address = TOKEN_A) {
  return {
    ...createSnapshot(address),
    mcap: 50000,
    vol1h: 50,
    vol6h: 1000,
    vol24h: 1000,
    liquidityUsd: 100,
    priceChange24h: -95,
    txns24hBuys: 20,
    txns24hSells: 50,
    gmgnInterval: '5m',
    gmgnIntervals: ['5m'],
  };
}

function createYoungExtremeGmgnSnapshot(address = TOKEN_A) {
  return {
    ...createSnapshot(address),
    mcap: 100000,
    vol1h: 1200000,
    vol6h: 2400000,
    vol24h: 2500000,
    liquidityUsd: 150000,
    tokenCreatedAt: '2026-05-03T06:15:00.000Z',
    gmgnInterval: '5m',
    gmgnIntervals: ['5m'],
  };
}

function createSafeGmgnSecurityStub() {
  return {
    async fetchTokenSecurity() {
      return {
        address: TOKEN_A,
        top10HolderRate: 0.45,
      };
    },
    async fetchTokenInfo() {
      return {
        address: TOKEN_A,
        holderCount: 500,
        marketCap: 100000,
      };
    },
    async fetchMarketKline() {
      return [
        { timestampMs: Date.parse('2026-05-03T06:45:00.000Z'), open: 1, high: 1.05, low: 0.99, close: 1.02, volume: 1000 },
        { timestampMs: Date.parse('2026-05-03T06:46:00.000Z'), open: 1.02, high: 1.03, low: 0.98, close: 0.99, volume: 1200 },
      ];
    },
  };
}

describe('gmgn catalog ingestion', () => {
  beforeEach(() => {
    gmgnRiskReviewQueue.stop();
    gmgnRiskReviewQueue.clear();
  });

  it('updates catalog, writes GMGN volume buckets, then evaluates alerts', async () => {
    const callOrder = [];
    const tokenCatalogModel = createTokenCatalogStub();
    const marketBucketModel = {
      async upsertSnapshotBucket(payload) {
        callOrder.push('marketBucket');
        assert.equal(payload.tokenAddress, TOKEN_A);
        assert.equal(payload.mcap, 250000);
        assert.equal(payload.price, 0.25);
        assert.equal(payload.source, 'gmgn');
        return payload;
      },
    };
    const volumeBucketModel = {
      async upsertSnapshotBucket(payload) {
        callOrder.push('volumeBucket');
        assert.equal(payload.tokenAddress, TOKEN_A);
        assert.equal(payload.vol1m, 4000);
        assert.equal(payload.vol5m, 10000);
        assert.equal(payload.source, 'gmgn');
        assert.deepEqual(payload.volumeCoverage, {
          '1m': 'complete',
          '5m': 'partial',
          '1h': 'complete',
          '6h': 'complete',
          '24h': 'complete',
        });
        return payload;
      },
    };
    const alertMatcher = {
      async evaluateUpdatedToken(payload, options) {
        callOrder.push('matcher');
        assert.equal(payload.tokenBefore.address, TOKEN_A);
        assert.equal(payload.tokenAfter.source, 'gmgn');
        assert.equal(options.now.toISOString(), '2026-05-03T07:00:00.000Z');
        return { emitted: 1, events: [{ ruleKey: 'gmgn-vol-1m' }] };
      },
    };
    tokenCatalogModel.upsertToken = async (payload) => {
      callOrder.push('upsertToken');
      assert.equal(payload.chain, 'solana');
      assert.equal(payload.source, 'gmgn');
      assert.equal(payload.tokenCreatedAt, Date.parse('2026-05-03T06:00:00.000Z'));
      return { address: payload.address, source: payload.source };
    };
    tokenCatalogModel.applyEvaluationResult = async (address, payload) => {
      callOrder.push('applyEvaluationResult');
      assert.equal(address, TOKEN_A);
      assert.equal(payload.eligibilityState, 'gmgn-high');
      assert.equal(payload.monitorPriority, 'high');
      assert.equal(payload.eligibleForMonitoring, true);
      assert.equal(payload.nextEvaluationAt.toISOString(), '2026-05-03T07:00:30.000Z');
      return {
        address,
        source: 'gmgn',
        eligible_for_monitoring: true,
        last_vol_5m: payload.vol5m,
      };
    };

    const result = await gmgnCatalogIngestion.ingestGmgnToken(createSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel,
      marketBucketModel,
      volumeBucketModel,
      alertMatcher,
    });

    assert.deepEqual(callOrder, [
      'upsertToken',
      'applyEvaluationResult',
      'marketBucket',
      'volumeBucket',
      'matcher',
    ]);
    assert.equal(result.summary.processed, 1);
    assert.equal(result.summary.catalogUpdated, 1);
    assert.equal(result.summary.marketBucketsWritten, 1);
    assert.equal(result.summary.volumeBucketsWritten, 1);
    assert.equal(result.summary.matcherEvaluations, 1);
    assert.equal(result.summary.matcherEmitted, 1);
    assert.equal(result.summary.gmgn1mAlerts, 1);
  });

  it('preserves recent DexScreener market cap and price when GMGN reports inflated FDV-style mcap', async () => {
    const tokenCatalogModel = createTokenCatalogStub();
    tokenCatalogModel.getByAddress = async (address) => ({
      address,
      source: 'user-manual',
      eligibility_state: 'dex-high',
      eligible_for_monitoring: true,
      last_pair_url: 'https://dexscreener.com/solana/cards-pair',
      last_mcap: 62425152,
      last_price: 0.2423,
      last_vol_5m: 3000,
      metadata_updated_at: '2026-06-28T00:13:30.000Z',
    });

    let catalogPayload = null;
    let evaluationPayload = null;
    let marketBucketPayload = null;
    let volumeBucketPayload = null;
    tokenCatalogModel.upsertToken = async (payload) => {
      catalogPayload = payload;
      return { address: payload.address, source: payload.source };
    };
    tokenCatalogModel.applyEvaluationResult = async (address, payload) => {
      evaluationPayload = payload;
      return {
        address,
        source: 'user-manual',
        eligible_for_monitoring: true,
        eligibility_state: payload.eligibilityState,
        last_mcap: payload.mcap,
        last_vol_5m: payload.vol5m,
      };
    };

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(TOKEN_A),
      mcap: 481958457.81,
      price: 0.2410147,
      vol5m: 6451.07,
      priceChange1h: 0.05,
      pairAddress: TOKEN_B,
      pairUrl: 'https://gmgn.ai/sol/token/cards',
    }, {
      now: () => new Date('2026-06-28T00:14:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel,
      marketBucketModel: {
        async upsertSnapshotBucket(payload) {
          marketBucketPayload = payload;
          return payload;
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          volumeBucketPayload = payload;
          return payload;
        },
      },
      alertMatcher: { async evaluateUpdatedToken() { return { emitted: 0, events: [] }; } },
    });

    assert.equal(catalogPayload.mcap, 62425152);
    assert.equal(catalogPayload.price, 0.2423);
    assert.equal(catalogPayload.vol5m, 3000);
    assert.equal(catalogPayload.vol1h, 50000);
    assert.equal(catalogPayload.priceChange1h, 0.05);
    assert.equal(evaluationPayload.mcap, 62425152);
    assert.equal(evaluationPayload.price, 0.2423);
    assert.equal(marketBucketPayload.mcap, 62425152);
    assert.equal(marketBucketPayload.price, 0.2423);
    assert.equal(marketBucketPayload.source, 'gmgn');
    assert.equal(volumeBucketPayload.vol5m, 3000);
    assert.equal(volumeBucketPayload.vol1h, 50000);
    assert.equal(volumeBucketPayload.source, 'gmgn');
    assert.equal(result.summary.marketBucketsWritten, 1);
    assert.equal(result.summary.volumeBucketsWritten, 1);
  });

  it('does not preserve stale pair-url market data over current GMGN market cap for GMGN catalog rows', () => {
    const snapshot = gmgnCatalogIngestion.__private.preserveDexMarketDataForGmgnSnapshot(
      {
        mcap: 7786240,
        price: 0.00762409,
      },
      {
        source: 'gmgn',
        eligibility_state: 'gmgn-low',
        last_pair_url: 'https://dexscreener.com/solana/cards-pair',
        last_mcap: 11550,
        last_price: 0.00001155,
        metadata_updated_at: '2026-07-06T06:46:14.003Z',
      },
      new Date('2026-07-06T06:46:20.000Z')
    );

    assert.equal(snapshot.mcap, 7786240);
    assert.equal(snapshot.price, 0.00762409);
  });

  it('suppresses GMGN FDV-style market cap when recent market data implies a lower supply', async () => {
    const snapshot = await gmgnCatalogIngestion.__private.suppressGmgnFdvMarketCap(
      {
        address: TOKEN_A,
        mcap: 9833310,
        price: 0.00983386,
        raw: {
          market_cap: '9833310',
          total_supply: '999944518',
        },
      },
      {
        source: 'gmgn',
        last_mcap: 9369350,
        last_price: 0.00936987,
        metadata_updated_at: '2026-07-06T07:23:30.000Z',
      },
      {
        marketBucketModel: {
          async listHistoryByAddress(address, options) {
            assert.equal(address, TOKEN_A);
            assert.deepEqual(options, { limit: 60, hours: 2 });
            return [
              {
                ts: '2026-07-06T07:41:00.000Z',
                closeMcap: 4720896,
                closePrice: 0.009836,
                source: 'dexscreener',
              },
              {
                ts: '2026-07-06T07:41:20.000Z',
                closeMcap: 9833860,
                closePrice: 0.00983386,
                source: 'dexscreener',
              },
            ];
          },
        },
      },
      new Date('2026-07-06T07:41:25.000Z'),
      TOKEN_A
    );

    assert.equal(Math.round(snapshot.mcap), 4719869);
    assert.equal(snapshot.price, 0.00983386);
  });

  it('recovers a transient missing GMGN market cap from the prior implied circulating supply', () => {
    const recovered = gmgnCatalogIngestion.__private.recoverMissingGmgnMarketCap(
      { mcap: 0, price: 0.00003 },
      {
        last_mcap: 24000,
        last_price: 0.000024,
        metadata_updated_at: '2026-05-03T06:59:30.000Z',
      },
      new Date('2026-05-03T07:00:00.000Z')
    );

    assert.equal(Math.round(recovered.mcap), 30000);

    const stale = gmgnCatalogIngestion.__private.recoverMissingGmgnMarketCap(
      { mcap: 0, price: 0.00003 },
      {
        last_mcap: 24000,
        last_price: 0.000024,
        metadata_updated_at: '2026-05-03T05:59:59.000Z',
      },
      new Date('2026-05-03T07:00:00.000Z')
    );

    assert.equal(stale.mcap, 0);
  });

  it('debounces repeated per-token alert evaluation while still persisting market data', async () => {
    let nowMs = Date.parse('2026-05-03T07:00:00.000Z');
    const evaluationState = new Map();
    let matcherCalls = 0;
    let bucketWrites = 0;

    const options = {
      now: () => new Date(nowMs),
      evaluationState,
      tokenCatalogModel: createTokenCatalogStub(),
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          bucketWrites += 1;
          return {};
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
          return {};
        },
      },
    };

    const first = await gmgnCatalogIngestion.ingestGmgnToken(createSnapshot(), options);
    nowMs += 1000;
    const second = await gmgnCatalogIngestion.ingestGmgnToken(createSnapshot(), options);

    assert.equal(first.summary.matcherEvaluations, 1);
    assert.equal(second.summary.matcherEvaluations, 0);
    assert.equal(second.summary.matcherSkippedDebounce, 1);
    assert.equal(matcherCalls, 1);
    assert.equal(bucketWrites, 2);
  });

  it('persists GMGN visual buckets but skips alerts for automatic tokens without DEX confirmation or preliminary review', async () => {
    let matcherCalls = 0;
    let marketBucketWrites = 0;
    let volumeBucketWrites = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      mcap: 50000,
      vol5m: 18000,
      vol1h: 50000,
      vol24h: 350000,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken(payload) {
          return { address: payload.address, source: payload.source };
        },
        async applyEvaluationResult(address, payload) {
          assert.equal(payload.eligibilityState, 'gmgn-normal');
          assert.equal(payload.eligibleForMonitoring, true);
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: true,
            eligibility_state: payload.eligibilityState,
            last_vol_5m: payload.vol5m,
            last_pair_url: payload.pairUrl,
          };
        },
      },
      marketBucketModel: {
        async upsertSnapshotBucket(payload) {
          marketBucketWrites += 1;
          assert.equal(payload.mcap, 50000);
          assert.equal(payload.source, 'gmgn');
          return {};
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          volumeBucketWrites += 1;
          return {};
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
          return {};
        },
      },
    });

    assert.equal(result.summary.catalogUpdated, 1);
    assert.equal(result.summary.marketBucketsWritten, 1);
    assert.equal(result.summary.volumeBucketsWritten, 1);
    assert.equal(result.summary.matcherEvaluations, 0);
    assert.equal(result.summary.matcherSkippedGmgnSafeguard, 1);
    assert.equal(marketBucketWrites, 1);
    assert.equal(volumeBucketWrites, 1);
    assert.equal(matcherCalls, 0);
  });

  it('suppresses new non-launch GMGN tokens from monitoring for the first 15 minutes', async () => {
    let matcherCalls = 0;
    const catalog = createTokenCatalogStub();
    catalog.getByAddress = async (address) => {
      catalog.calls.push(['getByAddress', address]);
      return null;
    };
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES'),
      tokenCreatedAt: '2026-05-03T06:55:00.000Z',
      mcap: 50000,
      liquidityUsd: 90000,
      vol5m: 18000,
      vol1h: 60000,
      vol24h: 120000,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          return {};
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
          return {};
        },
      },
    });

    const evaluationPayload = catalog.calls.find((call) => call[0] === 'applyEvaluationResult')[2];
    assert.equal(result.summary.catalogUpdated, 1);
    assert.equal(result.summary.volumeBucketsWritten, 0);
    assert.equal(result.summary.matcherEvaluations, 0);
    assert.equal(result.summary.matcherSkippedGmgnSafeguard, 1);
    assert.equal(evaluationPayload.eligibilityState, 'gmgn-non-launch-grace');
    assert.equal(evaluationPayload.eligibleForMonitoring, false);
    assert.equal(evaluationPayload.suppressedReason, 'gmgn_non_launch_grace_period');
    assert.equal(evaluationPayload.nextEvaluationAt.toISOString(), '2026-05-03T07:10:00.000Z');
    assert.equal(matcherCalls, 0);
  });

  it('allows GMGN alert evaluation after preliminary GMGN risk checks pass', async () => {
    let matcherCalls = 0;
    let bucketWrites = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken(createSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken(payload) {
          return { address: payload.address, source: payload.source };
        },
        async applyEvaluationResult(address, payload) {
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: true,
            eligibility_state: payload.eligibilityState,
            last_vol_5m: payload.vol5m,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          bucketWrites += 1;
          return {};
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.equal(result.summary.matcherSkippedGmgnSafeguard, 0);
    assert.equal(result.summary.volumeBucketsWritten, 1);
    assert.equal(result.summary.matcherEvaluations, 1);
    assert.equal(bucketWrites, 1);
    assert.equal(matcherCalls, 1);
  });

  it('limits GMGN preliminary risk lookups per ingestion cycle', async () => {
    const catalog = createTokenCatalogStub();
    const matcherCalls = [];
    let securityCalls = 0;
    let infoCalls = 0;
    let klineCalls = 0;

    catalog.getByAddress = async () => null;

    const result = await gmgnCatalogIngestion.ingestGmgnTokens([
      createSnapshot(TOKEN_A),
      createSnapshot(TOKEN_B),
    ], {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      gmgnRiskReviewMode: 'queued',
      gmgnRiskLookupTokenLimitPerCycle: 1,
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket() {},
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          securityCalls += 1;
          return { top10HolderRate: 0.12 };
        },
        async fetchTokenInfo() {
          infoCalls += 1;
          return { holderCount: 500, marketCap: 250000 };
        },
        async fetchMarketKline() {
          klineCalls += 1;
          return [
            { timestampMs: Date.parse('2026-05-03T06:45:00.000Z'), open: 1, high: 1.05, low: 0.99, close: 1.02, volume: 1000 },
            { timestampMs: Date.parse('2026-05-03T06:46:00.000Z'), open: 1.02, high: 1.03, low: 0.98, close: 0.99, volume: 1200 },
          ];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken(payload) {
          matcherCalls.push(payload.tokenAfter.address);
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.equal(result.gmgnRiskReviewQueued, 2);
    assert.equal(result.gmgnRiskLookupBudgetUsed, 0);
    assert.equal(result.gmgnRiskLookupBudgetSkipped, 0);
    assert.equal(result.gmgnSecurityChecks, 0);
    assert.equal(result.gmgnInfoChecks, 0);
    assert.equal(result.gmgnKlineChecks, 0);
    assert.equal(securityCalls, 0);
    assert.equal(infoCalls, 0);
    assert.equal(klineCalls, 0);
    assert.deepEqual(matcherCalls, []);
    assert.equal(result.matcherSkippedGmgnSafeguard, 2);
    assert.equal(result.catalogUpdated, 2);
    assert.equal(result.volumeBucketsWritten, 2);
  });

  it('processes queued GMGN risk review independently and evaluates alerts after pass', async () => {
    let matcherCalls = 0;
    let securityCalls = 0;

    const result = await gmgnCatalogIngestion.processQueuedGmgnRiskReview({
      address: TOKEN_A,
      snapshot: createSnapshot(TOKEN_A),
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress(address) {
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: true,
            eligibility_state: 'gmgn-high',
            last_vol_5m: 18000,
          };
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          securityCalls += 1;
          return { top10HolderRate: 0.12 };
        },
        async fetchTokenInfo() {
          return { holderCount: 500, marketCap: 250000 };
        },
        async fetchMarketKline() {
          return [
            { timestampMs: Date.parse('2026-05-03T06:45:00.000Z'), open: 1, high: 1.05, low: 0.99, close: 1.02, volume: 1000 },
            { timestampMs: Date.parse('2026-05-03T06:46:00.000Z'), open: 1.02, high: 1.03, low: 0.98, close: 0.99, volume: 1200 },
          ];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.equal(result.passed, true);
    assert.equal(result.autoBlocked, false);
    assert.equal(result.summary.gmgnSecurityChecks, 1);
    assert.equal(result.summary.gmgnInfoChecks, 1);
    assert.equal(result.summary.gmgnKlineChecks, 1);
    assert.equal(result.summary.matcherEvaluations, 1);
    assert.equal(securityCalls, 1);
    assert.equal(matcherCalls, 1);
  });

  it('suppresses low-activity automatic GMGN tokens using the existing 24h volume guard', () => {
    const evaluation = gmgnCatalogIngestion.__private.deriveGmgnEvaluation(
      { ...createSnapshot(), vol1h: 300, vol6h: 900, vol24h: 1200 },
      { source: 'dexscreener-discovery' },
      {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        activeDexRecheckMs: 30000,
      }
    );

    assert.equal(evaluation.eligibilityState, 'gmgn-low-activity');
    assert.equal(evaluation.eligibleForMonitoring, false);
    assert.equal(evaluation.suppressedReason, 'low_activity_24h');
    assert.equal(evaluation.nextEvaluationAt.toISOString(), '2026-05-03T07:03:00.000Z');
  });

  it('preserves the previous GMGN state when low 24h volume conflicts with active shorter windows', () => {
    const evaluation = gmgnCatalogIngestion.__private.deriveGmgnEvaluation(
      { ...createSnapshot(), vol1h: 68894.7, vol6h: 3967.08, vol24h: 3967.08 },
      {
        source: 'gmgn',
        eligible_for_monitoring: true,
        eligibility_state: 'dex-high',
        suppressed_reason: null,
        monitor_priority: 'high',
        next_evaluation_at: new Date('2026-05-03T07:00:05.000Z'),
      },
      {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        activeDexRecheckMs: 30000,
      }
    );

    assert.equal(evaluation.eligibilityState, 'dex-high');
    assert.equal(evaluation.eligibleForMonitoring, true);
    assert.equal(evaluation.suppressedReason, null);
    assert.equal(evaluation.monitorPriority, 'high');
    assert.equal(evaluation.nextEvaluationAt.toISOString(), '2026-05-03T07:00:05.000Z');
  });

  it('does not defer an existing Dex recheck when GMGN refreshes a Dex-confirmed token', () => {
    const evaluation = gmgnCatalogIngestion.__private.deriveGmgnEvaluation(
      createSnapshot(),
      {
        source: 'gmgn',
        eligibility_state: 'dex-high',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        next_evaluation_at: new Date('2026-05-03T07:00:05.000Z'),
      },
      {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        activeDexRecheckMs: 30000,
      }
    );

    assert.equal(evaluation.nextEvaluationAt.toISOString(), '2026-05-03T07:00:05.000Z');
  });

  it('advances an overdue Dex recheck when GMGN refreshes a token without Dex confirmation', () => {
    const evaluation = gmgnCatalogIngestion.__private.deriveGmgnEvaluation(
      createSnapshot(),
      {
        source: 'gmgn',
        eligibility_state: 'gmgn-high',
        next_evaluation_at: new Date('2026-05-03T06:59:50.000Z'),
      },
      {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        activeDexRecheckMs: 30000,
      }
    );

    assert.equal(evaluation.nextEvaluationAt.toISOString(), '2026-05-03T07:00:30.000Z');
  });

  it('does not apply the GMGN non-launch grace period to known launch suffixes or Dex-confirmed tokens', () => {
    const now = () => new Date('2026-05-03T07:00:00.000Z');
    const pumpEvaluation = gmgnCatalogIngestion.__private.deriveGmgnEvaluation(
      {
        ...createSnapshot('3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2pump'),
        tokenCreatedAt: '2026-05-03T06:55:00.000Z',
        mcap: 50000,
      },
      null,
      { now, activeDexRecheckMs: 30000 }
    );
    const dexEvaluation = gmgnCatalogIngestion.__private.deriveGmgnEvaluation(
      {
        ...createSnapshot(),
        tokenCreatedAt: '2026-05-03T06:55:00.000Z',
        mcap: 50000,
      },
      {
        source: 'dexscreener-discovery',
        eligibility_state: 'dex-normal',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
      },
      { now, activeDexRecheckMs: 30000 }
    );

    assert.equal(pumpEvaluation.eligibilityState, 'gmgn-normal');
    assert.equal(pumpEvaluation.eligibleForMonitoring, true);
    assert.equal(dexEvaluation.eligibilityState, 'gmgn-normal');
    assert.equal(dexEvaluation.eligibleForMonitoring, true);
  });

  it('preserves manual catalog source while still treating the bucket source as GMGN', () => {
    const payload = gmgnCatalogIngestion.__private.buildCatalogPayload(
      createSnapshot(),
      { source: 'user-manual' }
    );
    const bucketPayload = gmgnCatalogIngestion.__private.buildVolumeBucketPayload(
      createSnapshot(),
      new Date('2026-05-03T07:00:00.000Z')
    );

    assert.equal(payload.source, 'user-manual');
    assert.equal(bucketPayload.chain, 'solana');
    assert.equal(bucketPayload.source, 'gmgn');
  });

  it('fills young GMGN 6h and 24h volume windows before catalog and bucket writes', async () => {
    const catalog = createTokenCatalogStub();
    const bucketWrites = [];

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      vol5m: 91000,
      vol1h: 663000,
      vol6h: 0,
      vol24h: null,
      tokenCreatedAt: '2026-05-03T06:30:00.000Z',
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          bucketWrites.push(payload);
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
    });

    const upsertPayload = catalog.calls.find((call) => call[0] === 'upsertToken')[1];
    const evaluationPayload = catalog.calls.find((call) => call[0] === 'applyEvaluationResult')[2];

    assert.equal(upsertPayload.vol6h, 663000);
    assert.equal(upsertPayload.vol24h, 663000);
    assert.equal(evaluationPayload.vol6h, 663000);
    assert.equal(evaluationPayload.vol24h, 663000);
    assert.equal(bucketWrites[0].vol6h, 663000);
    assert.equal(bucketWrites[0].vol24h, 663000);
    assert.equal(result.snapshot.vol6h, 663000);
    assert.equal(result.snapshot.vol24h, 663000);
  });

  it('does not let GMGN zero out existing positive rolling volume windows', async () => {
    const catalog = createTokenCatalogStub();
    const bucketWrites = [];
    catalog.getByAddress = async (address) => ({
      address,
      source: 'dexscreener-discovery',
      eligibility_state: 'dex-high',
      eligible_for_monitoring: true,
      last_vol_1h: 72382.4,
      last_vol_6h: 953689.09,
      last_vol_24h: 3932979.94,
    });

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      vol1h: 0,
      vol6h: 0,
      vol24h: 3932160,
      tokenCreatedAt: '2026-04-03T06:00:00.000Z',
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          bucketWrites.push(payload);
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
    });

    const upsertPayload = catalog.calls.find((call) => call[0] === 'upsertToken')[1];
    const evaluationPayload = catalog.calls.find((call) => call[0] === 'applyEvaluationResult')[2];

    assert.equal(upsertPayload.vol1h, 72382.4);
    assert.equal(upsertPayload.vol6h, 953689.09);
    assert.equal(upsertPayload.vol24h, 3932160);
    assert.equal(evaluationPayload.vol1h, 72382.4);
    assert.equal(evaluationPayload.vol6h, 953689.09);
    assert.equal(evaluationPayload.vol24h, 3932160);
    assert.equal(bucketWrites[0].vol1h, 72382.4);
    assert.equal(bucketWrites[0].vol6h, 953689.09);
    assert.equal(result.snapshot.vol1h, 72382.4);
    assert.equal(result.snapshot.vol6h, 953689.09);
  });

  it('does not let incoherent GMGN cumulative volume replace stronger existing windows', async () => {
    const catalog = createTokenCatalogStub();
    const bucketWrites = [];
    catalog.getByAddress = async (address) => ({
      address,
      source: 'gmgn',
      eligibility_state: 'dex-high',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_vol_1h: 50376.47,
      last_vol_6h: 1051261.67,
      last_vol_24h: 1703467.79,
    });

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      vol1h: 68894.7,
      vol6h: 3967.08,
      vol24h: 3967.08,
      tokenCreatedAt: '2026-04-03T06:00:00.000Z',
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          bucketWrites.push(payload);
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
    });

    const upsertPayload = catalog.calls.find((call) => call[0] === 'upsertToken')[1];
    const evaluationPayload = catalog.calls.find((call) => call[0] === 'applyEvaluationResult')[2];

    assert.equal(upsertPayload.vol1h, 68894.7);
    assert.equal(upsertPayload.vol6h, 1051261.67);
    assert.equal(upsertPayload.vol24h, 1703467.79);
    assert.equal(evaluationPayload.vol6h, 1051261.67);
    assert.equal(evaluationPayload.vol24h, 1703467.79);
    assert.equal(evaluationPayload.eligibilityState, 'gmgn-high');
    assert.equal(evaluationPayload.eligibleForMonitoring, true);
    assert.equal(bucketWrites[0].vol6h, 1051261.67);
    assert.equal(bucketWrites[0].vol24h, 1703467.79);
    assert.equal(result.snapshot.vol6h, 1051261.67);
    assert.equal(result.snapshot.vol24h, 1703467.79);
  });

  it('does not let coherent low-activity GMGN volume suppress an already active token', async () => {
    const catalog = createTokenCatalogStub();
    const bucketWrites = [];
    catalog.getByAddress = async (address) => ({
      address,
      source: 'gmgn',
      eligibility_state: 'dex-high',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_vol_1h: 21477.58,
      last_vol_6h: 326832.75,
      last_vol_24h: 1857602.72,
    });

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      mcap: 424144,
      vol1h: 1200,
      vol6h: 1200,
      vol24h: 1200,
      tokenCreatedAt: '2026-04-03T06:00:00.000Z',
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          bucketWrites.push(payload);
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
    });

    const upsertPayload = catalog.calls.find((call) => call[0] === 'upsertToken')[1];
    const evaluationPayload = catalog.calls.find((call) => call[0] === 'applyEvaluationResult')[2];

    assert.equal(upsertPayload.vol1h, 21477.58);
    assert.equal(upsertPayload.vol6h, 326832.75);
    assert.equal(upsertPayload.vol24h, 1857602.72);
    assert.equal(evaluationPayload.eligibilityState, 'gmgn-high');
    assert.equal(evaluationPayload.eligibleForMonitoring, true);
    assert.equal(evaluationPayload.suppressedReason, null);
    assert.equal(evaluationPayload.vol24h, 1857602.72);
    assert.equal(bucketWrites[0].vol24h, 1857602.72);
    assert.equal(result.snapshot.vol24h, 1857602.72);
  });

  it('keeps Dex-confirmed 5m volume when GMGN reports inconsistent interval volume', async () => {
    const catalog = createTokenCatalogStub();
    const bucketWrites = [];
    catalog.getByAddress = async (address) => ({
      address,
      source: 'user-manual',
      eligibility_state: 'dex-normal',
      eligible_for_monitoring: true,
      last_pair_url: 'https://dexscreener.com/solana/testpair',
      last_vol_5m: 4300,
      last_vol_1h: 64000,
    });

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      vol1m: 64000,
      vol5m: 64000,
      vol1h: 64000,
      vol6h: 64000,
      vol24h: 64000,
      tokenCreatedAt: '2026-05-03T06:30:00.000Z',
      gmgnIntervals: ['1m', '5m', '1h', '6h', '24h'],
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: catalog,
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          bucketWrites.push(payload);
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
    });

    const upsertPayload = catalog.calls.find((call) => call[0] === 'upsertToken')[1];
    const evaluationPayload = catalog.calls.find((call) => call[0] === 'applyEvaluationResult')[2];

    assert.equal(upsertPayload.source, 'user-manual');
    assert.equal(upsertPayload.vol5m, 4300);
    assert.equal(evaluationPayload.vol5m, 4300);
    assert.equal(bucketWrites[0].vol5m, 4300);
    assert.equal(result.snapshot.vol5m, 4300);
    assert.equal(result.snapshot.vol1m, 64000);
  });

  it('skips new tokens discovered only in GMGN 1m trending', async () => {
    let upsertCalls = 0;
    let bucketWrites = 0;
    let matcherCalls = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      gmgnInterval: '1m',
      gmgnIntervals: ['1m'],
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult() {
          throw new Error('should not evaluate skipped GMGN 1m-only discovery');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          bucketWrites += 1;
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-1m-only-discovery');
    assert.equal(result.summary.skipped1mOnlyDiscovery, 1);
    assert.equal(upsertCalls, 0);
    assert.equal(bucketWrites, 0);
    assert.equal(matcherCalls, 0);
  });

  it('allows old unknown tokens discovered only in GMGN 1m trending into catalog flow', async () => {
    let upsertCalls = 0;
    let evaluationCalls = 0;
    let bucketWrites = 0;
    let matcherCalls = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      tokenCreatedAt: '2026-05-02T06:59:59.000Z',
      vol5m: null,
      gmgnInterval: '1m',
      gmgnIntervals: ['1m'],
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult(address, payload) {
          evaluationCalls += 1;
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: payload.eligibleForMonitoring,
            eligibility_state: payload.eligibilityState,
            suppressed_reason: payload.suppressedReason,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          bucketWrites += 1;
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
        },
      },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.skipped1mOnlyDiscovery, 0);
    assert.equal(result.summary.matcherSkippedGmgnSafeguard, 1);
    assert.equal(upsertCalls, 1);
    assert.equal(evaluationCalls, 1);
    assert.equal(bucketWrites, 1);
    assert.equal(matcherCalls, 0);
  });

  it('auto-blocks young GMGN-only tokens with liquidity under 1k before bucket writes', async () => {
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES'),
      tokenCreatedAt: '2026-05-03T06:35:00.000Z',
      mcap: 84550.6,
      liquidityUsd: 721.2,
      vol5m: 18000,
      vol1h: 60000,
      vol6h: 90000,
      vol24h: 120000,
      gmgnInterval: '5m',
      gmgnIntervals: ['5m'],
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('low-liquidity spam block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('brand-new low-liquidity spam block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked low-liquidity GMGN tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          throw new Error('low-liquidity spam block must not depend on GMGN security lookup');
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked low-liquidity GMGN tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-low-liquidity-spam-auto-blocked');
    assert.equal(result.summary.gmgnLowLiquiditySpamAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].label, 'gmgn-liquidity:under-1k-spam:721:84551');
    assert.equal(blockWrites[0].evidence.pipeline, 'gmgn-ingestion:low-liquidity-spam');
    assert.equal(blockWrites[0].evidence.marketSnapshot.liquidityUsd, 721.2);
    assert.equal(blockWrites[0].evidence.marketSnapshot.mcap, 84550.6);
  });

  it('does not auto-block low-liquidity GMGN-only tokens when mcap is missing', () => {
    const shouldBlock = gmgnCatalogIngestion.__private.isGmgnLowLiquiditySpamRisk(
      'nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES',
      {
        tokenCreatedAt: '2026-05-03T06:35:00.000Z',
        mcap: null,
        liquidityUsd: 721.2,
      },
      null,
      new Date('2026-05-03T07:00:00.000Z')
    );

    assert.equal(shouldBlock, false);
  });

  it('auto-blocks GMGN-only mid-cap tokens with multiple bad liquidity statuses before expensive checks', async () => {
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES'),
      tokenCreatedAt: '2026-05-03T06:35:00.000Z',
      mcap: 84550.6,
      liquidityUsd: 2500,
      vol5m: 18000,
      vol1h: 60000,
      vol6h: 90000,
      vol24h: 120000,
      gmgnInterval: '5m',
      gmgnIntervals: ['5m'],
      raw: {
        lock_percent: 0,
        burn_ratio: 0,
        burn_status: 'none',
      },
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('bad-liquidity-status block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('brand-new bad-liquidity-status block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked bad-liquidity-status GMGN tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          throw new Error('bad-liquidity-status block must not depend on GMGN security lookup');
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked bad-liquidity-status GMGN tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-bad-liquidity-status-auto-blocked');
    assert.equal(result.summary.gmgnBadLiquidityStatusAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(
      blockWrites[0].label,
      'gmgn-liquidity:bad-status-mcap-band:84551:3bad:lock_zero:burn_ratio_zero:burn_status_none'
    );
    assert.equal(blockWrites[0].evidence.pipeline, 'gmgn-ingestion:bad-liquidity-status-mcap-band');
    assert.equal(blockWrites[0].evidence.marketSnapshot.mcap, 84550.6);
  });

  it('does not auto-block user manual addresses even when the catalog source is still GMGN', async () => {
    let blockCalls = 0;
    let upsertPayload = null;
    let marketBucketWrites = 0;
    let volumeBucketWrites = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('Cu7FMijRAWqKuDxALX1xbJferuD8vAhWzFfkdGoQ7R76'),
      tokenCreatedAt: '2026-05-23T20:21:44.000Z',
      mcap: 30851.7,
      liquidityUsd: 18571.9,
      vol1m: 13907.4,
      vol5m: 23919.6,
      vol1h: 23919.6,
      vol6h: 23919.6,
      vol24h: 23919.6,
      gmgnInterval: '5m',
      gmgnIntervals: ['5m'],
      raw: {
        lock_percent: 0,
        burn_ratio: 0,
        creator_close: true,
        creator_token_status: 'creator_close',
      },
    }, {
      now: () => new Date('2026-05-23T20:35:35.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add() {
          blockCalls += 1;
        },
      },
      tokenCatalogModel: {
        async getByAddress(address) {
          return { address, source: 'gmgn' };
        },
        async hasUserManualAddress() {
          return true;
        },
        async upsertToken(payload) {
          upsertPayload = payload;
          return { address: payload.address, source: payload.source };
        },
        async applyEvaluationResult(address, payload) {
          return { address, source: 'user-manual', last_vol_5m: payload.vol5m };
        },
      },
      marketBucketModel: {
        async upsertSnapshotBucket() {
          marketBucketWrites += 1;
          return {};
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          volumeBucketWrites += 1;
          return {};
        },
      },
      alertMatcher: { async evaluateUpdatedToken() { return {}; } },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.gmgnBadLiquidityStatusAutoBlocked, 0);
    assert.equal(blockCalls, 0);
    assert.equal(upsertPayload.source, 'user-manual');
    assert.equal(marketBucketWrites, 1);
    assert.equal(volumeBucketWrites, 1);
  });

  it('does not auto-block GMGN bad liquidity statuses outside mcap band or known launch suffixes', async () => {
    const cases = [
      {
        address: 'nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES',
        mcap: 19999,
      },
      {
        address: 'nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES',
        mcap: 150001,
      },
      {
        address: '3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2pump',
        mcap: 84550.6,
      },
      {
        address: '3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2bonk',
        mcap: 84550.6,
      },
      {
        address: 'nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES',
        mcap: 84550.6,
        tokenCreatedAt: '2026-05-03T04:59:59.000Z',
      },
    ];

    for (const { address, mcap, tokenCreatedAt = '2026-05-03T06:35:00.000Z' } of cases) {
      let upsertCalls = 0;
      const blockWrites = [];
      const result = await gmgnCatalogIngestion.ingestGmgnToken({
        ...createSnapshot(address),
        tokenCreatedAt,
        mcap,
        liquidityUsd: 2500,
        vol5m: 18000,
        vol1h: 60000,
        vol6h: 90000,
        vol24h: 120000,
        raw: {
          lock_percent: 0,
          burn_ratio: 0,
          burn_status: 'none',
        },
      }, {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        evaluationState: new Map(),
        adminBlockedTokenModel: {
          async add(payload) {
            blockWrites.push(payload);
            return payload;
          },
        },
        tokenCatalogModel: {
          async getByAddress() {
            return null;
          },
          async upsertToken(payload) {
            upsertCalls += 1;
            return { address: payload.address, source: payload.source };
          },
          async applyEvaluationResult(addressValue, payload) {
            return {
              address: addressValue,
              source: 'gmgn',
              eligible_for_monitoring: payload.eligibleForMonitoring,
              suppressed_reason: payload.suppressedReason,
              last_vol_5m: payload.vol5m,
            };
          },
        },
        volumeBucketModel: { async upsertSnapshotBucket() {} },
        gmgnClient: createSafeGmgnSecurityStub(),
        alertMatcher: { async evaluateUpdatedToken() { return { emitted: 0, events: [] }; } },
      });

      assert.equal(result.summary.gmgnBadLiquidityStatusAutoBlocked, 0);
      assert.equal(blockWrites.length, 0);
      assert.equal(upsertCalls, 1);
    }
  });

  it('does not auto-block Dex-confirmed or known-launch-suffix tokens with liquidity under 1k', async () => {
    const cases = [
      {
        address: TOKEN_A,
        tokenBefore: {
          address: TOKEN_A,
          source: 'dexscreener-discovery',
          eligibility_state: 'dex-high',
          last_pair_url: 'https://dexscreener.com/solana/testpair',
        },
      },
      {
        address: '3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2pump',
        tokenBefore: null,
      },
    ];

    for (const { address, tokenBefore } of cases) {
      let upsertCalls = 0;
      const blockWrites = [];
      const result = await gmgnCatalogIngestion.ingestGmgnToken({
        ...createSnapshot(address),
        tokenCreatedAt: '2026-05-03T06:35:00.000Z',
        mcap: 84550.6,
        liquidityUsd: 721.2,
        vol5m: 18000,
        vol1h: 60000,
        vol6h: 90000,
        vol24h: 120000,
      }, {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        evaluationState: new Map(),
        adminBlockedTokenModel: {
          async add(payload) {
            blockWrites.push(payload);
            return payload;
          },
        },
        tokenCatalogModel: {
          async getByAddress() {
            return tokenBefore;
          },
          async upsertToken(payload) {
            upsertCalls += 1;
            return { address: payload.address, source: payload.source };
          },
          async applyEvaluationResult(tokenAddress, payload) {
            return {
              address: tokenAddress,
              source: payload.source || 'gmgn',
              eligible_for_monitoring: payload.eligibleForMonitoring,
              eligibility_state: payload.eligibilityState,
              last_vol_5m: payload.vol5m,
              last_pair_url: tokenBefore?.last_pair_url || null,
            };
          },
        },
        volumeBucketModel: {
          async upsertSnapshotBucket() {
            return {};
          },
        },
        gmgnClient: createSafeGmgnSecurityStub(),
        alertMatcher: {
          async evaluateUpdatedToken() {
            return { emitted: 0, events: [] };
          },
        },
      });

      assert.equal(result.skipped, undefined);
      assert.equal(result.summary.gmgnLowLiquiditySpamAutoBlocked, 0);
      assert.equal(blockWrites.length, 0);
      assert.equal(upsertCalls, 1);
    }
  });

  it('auto-blocks high-confidence GMGN junk before catalog upsert', async () => {
    const blockWrites = [];
    let upsertCalls = 0;
    let bucketWrites = 0;
    let matcherCalls = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken(createHighConfidenceJunkSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult() {
          throw new Error('should not apply catalog evaluation for brand-new skipped junk');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          bucketWrites += 1;
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          matcherCalls += 1;
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-junk-auto-blocked');
    assert.equal(result.summary.autoBlockedJunk, 1);
    assert.equal(result.summary.junkAssessments, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].address, TOKEN_A);
    assert.match(blockWrites[0].label, /^gmgn-auto-junk:/);
    assert.equal(upsertCalls, 0);
    assert.equal(bucketWrites, 0);
    assert.equal(matcherCalls, 0);
  });

  it('does not auto-block old GMGN junk discovered for the first time', async () => {
    let blockCalls = 0;
    let upsertCalls = 0;
    let evaluationCalls = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createHighConfidenceJunkSnapshot(),
      tokenCreatedAt: '2026-04-20T07:00:00.000Z',
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add() {
          blockCalls += 1;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult(address, payload) {
          evaluationCalls += 1;
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: payload.eligibleForMonitoring,
            eligibility_state: payload.eligibilityState,
            suppressed_reason: payload.suppressedReason,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          return {};
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('old first-seen GMGN token without review should not alert immediately');
        },
      },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.gmgnOldNewDiscoveryGuarded, 1);
    assert.equal(result.summary.autoBlockedJunk, 0);
    assert.equal(result.summary.junkAssessments, 0);
    assert.equal(blockCalls, 0);
    assert.equal(upsertCalls, 1);
    assert.equal(evaluationCalls, 1);
  });

  it('skips medium-confidence new GMGN junk without auto-blocking', async () => {
    let blockCalls = 0;
    let upsertCalls = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken(createMediumConfidenceJunkSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add() {
          blockCalls += 1;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult() {
          throw new Error('should not evaluate skipped suspect junk');
        },
      },
      volumeBucketModel: { async upsertSnapshotBucket() { return {}; } },
      alertMatcher: { async evaluateUpdatedToken() { return {}; } },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-junk-suspect');
    assert.equal(result.summary.skippedJunkSuspect, 1);
    assert.equal(result.summary.junkAssessments, 1);
    assert.equal(blockCalls, 0);
    assert.equal(upsertCalls, 0);
  });

  it('suppresses young extreme GMGN volume tokens without writing buckets until risk enrichment resolves them', async () => {
    const calls = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken(createYoungExtremeGmgnSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken(payload) {
          calls.push(['upsertToken', payload]);
          return { address: payload.address, source: payload.source };
        },
        async applyEvaluationResult(address, payload) {
          calls.push(['applyEvaluationResult', address, payload]);
          assert.equal(payload.eligibilityState, 'gmgn-needs-risk-enrichment');
          assert.equal(payload.eligibleForMonitoring, false);
          assert.equal(payload.suppressedReason, 'gmgn_needs_risk_enrichment');
          assert.equal(payload.monitorPriority, 'high');
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: false,
            suppressed_reason: payload.suppressedReason,
            last_vol_5m: payload.vol5m,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket(payload) {
          calls.push(['volumeBucket', payload]);
          return payload;
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('suppressed GMGN risk enrichment tokens must not alert');
        },
      },
    });

    assert.equal(result.summary.catalogUpdated, 1);
    assert.equal(result.summary.volumeBucketsWritten, 0);
    assert.equal(result.summary.matcherEvaluations, 0);
    assert.equal(result.summary.matcherSkippedSuppressed, 1);
    assert.equal(result.summary.riskEnrichmentSuppressed, 1);
    assert.deepEqual(calls.map(([name]) => name), ['upsertToken', 'applyEvaluationResult']);
    assert.equal(calls[0][1].isActiveMonitorCandidate, true);
  });

  it('quarantines very new GMGN tokens with concentrated top holders instead of auto-blocking', async () => {
    const blockWrites = [];
    let upsertCalls = 0;
    let bucketWrites = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(),
      tokenCreatedAt: '2026-05-03T06:55:00.000Z',
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult(address, payload) {
          assert.equal(payload.eligibilityState, 'gmgn-needs-risk-enrichment');
          assert.equal(payload.eligibleForMonitoring, false);
          assert.equal(payload.suppressedReason, 'gmgn_needs_risk_enrichment');
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: false,
            suppressed_reason: payload.suppressedReason,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          bucketWrites += 1;
        },
      },
      gmgnClient: {
        async fetchTokenSecurity(request) {
          assert.equal(request.address, TOKEN_A);
          assert.equal(request.chain, 'solana');
          return {
            address: TOKEN_A,
            top10HolderRate: 0.9234,
          };
        },
        async fetchTokenInfo() {
          return {
            address: TOKEN_A,
            holderCount: 500,
            marketCap: 100000,
          };
        },
        async fetchMarketKline() {
          return [
            { timestampMs: Date.parse('2026-05-03T06:55:00.000Z'), open: 1, high: 1.03, low: 0.99, close: 1.01, volume: 1000 },
            { timestampMs: Date.parse('2026-05-03T06:56:00.000Z'), open: 1.01, high: 1.02, low: 0.98, close: 0.99, volume: 1200 },
          ];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('quarantined GMGN security risk tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.gmgnSecurityChecks, 1);
    assert.equal(result.summary.gmgnSecurityAutoBlocked, 0);
    assert.equal(result.summary.gmgnSecurityErrors, 0);
    assert.equal(result.summary.riskEnrichmentSuppressed, 1);
    assert.equal(blockWrites.length, 0);
    assert.equal(upsertCalls, 1);
    assert.equal(bucketWrites, 0);
  });

  it('does not auto-block concentrated top holders without enough complementary bad signals', async () => {
    const blockWrites = [];
    let upsertCalls = 0;
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(),
      mcap: 264234,
      vol5m: 64409.82,
      vol1h: 1817446.48,
      vol6h: 1817446.48,
      vol24h: 1817446.48,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult(address, payload) {
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: payload.eligibleForMonitoring,
            eligibility_state: payload.eligibilityState,
            last_vol_5m: payload.vol5m,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {},
      },
      gmgnClient: {
        async fetchTokenSecurity(request) {
          assert.equal(request.address, TOKEN_A);
          return {
            address: TOKEN_A,
            top10HolderRate: 0.7864,
          };
        },
        async fetchTokenInfo() {
          return {
            address: TOKEN_A,
            holderCount: 500,
            marketCap: 264234,
          };
        },
        async fetchMarketKline() {
          return [
            { timestampMs: Date.parse('2026-05-03T06:45:00.000Z'), open: 1, high: 1.03, low: 0.99, close: 1.01, volume: 1000 },
            { timestampMs: Date.parse('2026-05-03T06:46:00.000Z'), open: 1.01, high: 1.02, low: 0.98, close: 0.99, volume: 1200 },
          ];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.notEqual(result.skipReason, 'gmgn-security-auto-blocked');
    assert.equal(result.summary.gmgnSecurityChecks, 1);
    assert.equal(result.summary.gmgnSecurityAutoBlocked, 0);
    assert.equal(blockWrites.length, 0);
    assert.equal(upsertCalls, 1);
  });

  it('auto-blocks concentrated top holders only with three complementary bad signals', async () => {
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(),
      tokenCreatedAt: '2026-05-03T06:30:00.000Z',
      mcap: 100000,
      vol5m: 18000,
      vol1h: 50000,
      vol6h: 50000,
      vol24h: 50000,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('GMGN security block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('GMGN security block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked GMGN security risk tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          return {
            address: TOKEN_A,
            top10HolderRate: 0.9234,
          };
        },
        async fetchTokenInfo() {
          return {
            address: TOKEN_A,
            holderCount: 2000,
            marketCap: 100000,
          };
        },
        async fetchMarketKline() {
          return [
            { timestampMs: Date.parse('2026-05-03T06:45:00.000Z'), open: 1, high: 1.03, low: 0.99, close: 1.01, volume: 1000 },
            { timestampMs: Date.parse('2026-05-03T06:46:00.000Z'), open: 1.01, high: 1.02, low: 0.98, close: 0.99, volume: 1200 },
          ];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked GMGN security risk tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-security-auto-blocked');
    assert.equal(result.summary.gmgnSecurityAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].label, 'gmgn-security:top10-holder-rate-92.34%');
    assert.deepEqual(blockWrites[0].evidence.assessment.badSignals, [
      'low_mcap_under_150k',
      'holder_count_high_low_mcap',
      'missing_dex_confirmation',
    ]);
  });

  it('does not auto-block pump, bonk, or bags suffix tokens solely for concentrated top holders', async () => {
    const security = { top10HolderRate: 0.9234 };
    assert.equal(
      gmgnCatalogIngestion.__private.isGmgnSecurityAutoBlockRisk(
        security,
        '3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2pump'
      ),
      false
    );
    assert.equal(
      gmgnCatalogIngestion.__private.isGmgnSecurityAutoBlockRisk(
        security,
        'BAGSoDxpPMzKz1VQDeeHTHSXbH6AGU1fLqJrtHTBAGS'
      ),
      false
    );
    assert.equal(
      gmgnCatalogIngestion.__private.isGmgnSecurityAutoBlockRisk(
        security,
        'BONKoDxpPMzKz1VQDeeHTHSXbH6AGU1fLqJrtHTbonk'
      ),
      false
    );
    assert.equal(
      gmgnCatalogIngestion.__private.hasGmgnSecurityTopHolderRisk(security, TOKEN_A),
      true
    );
  });

  it('continues GMGN ingestion for pump suffix tokens with isolated top holder concentration', async () => {
    const address = '3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2pump';
    const catalog = createTokenCatalogStub();
    const blockWrites = [];

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(address),
      mcap: 264234,
      vol5m: 64409.82,
      vol1h: 1817446.48,
      vol6h: 1817446.48,
      vol24h: 1817446.48,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        ...catalog,
        async getByAddress(tokenAddress) {
          catalog.calls.push(['getByAddress', tokenAddress]);
          return null;
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {},
      },
      gmgnClient: {
        async fetchTokenSecurity(request) {
          assert.equal(request.address, address);
          return {
            address,
            top10HolderRate: 0.9234,
          };
        },
        async fetchTokenInfo() {
          return {
            address,
            holderCount: 500,
            marketCap: 264234,
          };
        },
        async fetchMarketKline() {
          return [
            { timestampMs: Date.parse('2026-05-03T06:45:00.000Z'), open: 1, high: 1.03, low: 0.99, close: 1.01, volume: 1000 },
            { timestampMs: Date.parse('2026-05-03T06:46:00.000Z'), open: 1.01, high: 1.02, low: 0.98, close: 0.99, volume: 1200 },
          ];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.notEqual(result.skipReason, 'gmgn-security-auto-blocked');
    assert.equal(result.summary.gmgnSecurityChecks, 1);
    assert.equal(result.summary.gmgnSecurityAutoBlocked, 0);
    assert.equal(blockWrites.length, 0);
    assert.equal(catalog.calls.some(([name]) => name === 'upsertToken'), true);
  });

  it('auto-blocks young low-mcap GMGN tokens with extreme 5m volume before risk lookups', async () => {
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(),
      mcap: 73184,
      vol5m: 764289.53,
      vol1h: 5869396.99,
      vol6h: 5869396.99,
      vol24h: 5869396.99,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('low-mcap volume block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('brand-new low-mcap volume block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked low-mcap volume risk tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          throw new Error('low-mcap volume block must not depend on GMGN security lookup');
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked low-mcap volume risk tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-low-mcap-extreme-volume-auto-blocked');
    assert.equal(result.summary.gmgnLowMcapExtremeVolumeAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].label, 'gmgn-volume:low-mcap-extreme-vol5m:73184:764290');
  });

  it('auto-blocks new non-pump GMGN tokens with high launch mcap and extreme early volume before risk lookups', async () => {
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES'),
      tokenCreatedAt: '2026-05-03T06:45:00.000Z',
      mcap: 60000,
      vol5m: 250000,
      vol1h: 280000,
      vol6h: 280000,
      vol24h: 280000,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('new non-pump GMGN block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('brand-new non-pump GMGN block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked new non-pump GMGN tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          throw new Error('new non-pump GMGN block must not depend on GMGN security lookup');
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked new non-pump GMGN tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-new-non-pump-high-launch-mcap-auto-blocked');
    assert.equal(result.summary.gmgnNewNonPumpHighLaunchMcapAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].label, 'gmgn-origin:new-non-pump-high-launch-mcap:60000:250000');
    assert.equal(blockWrites[0].evidence.pipeline, 'gmgn-ingestion:new-non-pump-high-launch-mcap');
    assert.equal(blockWrites[0].evidence.marketSnapshot.mcap, 60000);
    assert.equal(blockWrites[0].evidence.marketSnapshot.vol5m, 250000);
    assert.equal(blockWrites[0].evidence.gmgnSnapshot.rawSnapshot.address, 'nCRDiU4kzScNFXowy7T9yo36zfHVswYBgrWUhfVAfES');
  });

  it('does not auto-block moderate low-mcap non-pump GMGN launches by the high-launch rule', async () => {
    const catalog = createTokenCatalogStub();
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('DFeoQbQDdpzZ1doCe3MC4bVoLqsG8dn1P8ymfEfGU5Pu'),
      tokenCreatedAt: '2026-05-17T05:40:00.000Z',
      mcap: 25158,
      vol5m: 44930,
      vol1h: 70000,
      vol6h: 70000,
      vol24h: 70000,
    }, {
      now: () => new Date('2026-05-17T05:50:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        ...catalog,
        async getByAddress(address) {
          catalog.calls.push(['getByAddress', address]);
          return null;
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {},
      },
      gmgnClient: createSafeGmgnSecurityStub(),
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.notEqual(result.skipped, true);
    assert.equal(result.summary.gmgnNewNonPumpHighLaunchMcapAutoBlocked, 0);
    assert.equal(blockWrites.length, 0);
    assert.equal(catalog.calls.some(([name]) => name === 'upsertToken'), true);
  });

  it('does not auto-block non-pump launches when GMGN 5m volume mirrors 1m volume', async () => {
    const catalog = createTokenCatalogStub();
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('2CqJo99Xwww753TfXDGjxUeVKPazn1sEwDZf4576Fcmm'),
      tokenCreatedAt: '2026-05-03T06:45:00.000Z',
      mcap: 36527,
      vol1m: 64383.8,
      vol5m: 67744,
      vol1h: 67744,
      vol6h: 67744,
      vol24h: 67744,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        ...catalog,
        async getByAddress(address) {
          catalog.calls.push(['getByAddress', address]);
          return null;
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {},
      },
      gmgnClient: createSafeGmgnSecurityStub(),
      alertMatcher: {
        async evaluateUpdatedToken() {
          return { emitted: 0, events: [] };
        },
      },
    });

    assert.notEqual(result.skipped, true);
    assert.equal(blockWrites.length, 0);
  });

  it('does not auto-block new pump-suffix GMGN tokens by the non-pump launch mcap rule', async () => {
    const catalog = createTokenCatalogStub();
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot('3QQQxazHaMb72d7N9iftT26vuk6A4Re31fYmkwA2pump'),
      tokenCreatedAt: '2026-05-03T06:45:00.000Z',
      mcap: 25000,
      vol5m: 12000,
      vol1h: 22000,
      vol6h: 22000,
      vol24h: 22000,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        ...catalog,
        async getByAddress(address) {
          catalog.calls.push(['getByAddress', address]);
          return null;
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {},
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          throw new Error('pump-suffix token below risk lookup thresholds must not need GMGN security lookup');
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('raw GMGN pump-suffix token should remain behind alert safeguard');
        },
      },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.gmgnNewNonPumpHighLaunchMcapAutoBlocked, 0);
    assert.equal(blockWrites.length, 0);
    assert.equal(catalog.calls.some(([name]) => name === 'upsertToken'), true);
  });

  it('does not auto-block GMGN launch mcap rule exceptions or launches above 100k', async () => {
    const cases = [
      ['BAGSoDxpPMzKz1VQDeeHTHSXbH6AGU1fLqJrtHTBAGS', 50000],
      ['BRRRoDxpPMzKz1VQDeeHTHSXbH6AGU1fLqJrtHTbrrr', 50000],
      ['3RJRyJqztZE1RkZkiqPUZ9vcJQLRK1zWPc7fZZP81aYV', 125000],
    ];

    for (const [address, mcap] of cases) {
      const catalog = createTokenCatalogStub();
      const blockWrites = [];
      const result = await gmgnCatalogIngestion.ingestGmgnToken({
        ...createSnapshot(address),
        tokenCreatedAt: '2026-05-03T06:45:00.000Z',
        mcap,
        vol5m: 130000,
        vol1h: 160000,
        vol6h: 160000,
        vol24h: 160000,
      }, {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        evaluationState: new Map(),
        adminBlockedTokenModel: {
          async add(payload) {
            blockWrites.push(payload);
            return payload;
          },
        },
        tokenCatalogModel: {
          ...catalog,
          async getByAddress(tokenAddress) {
            catalog.calls.push(['getByAddress', tokenAddress]);
            return null;
          },
        },
        volumeBucketModel: {
          async upsertSnapshotBucket() {},
        },
        gmgnClient: createSafeGmgnSecurityStub(),
        alertMatcher: {
          async evaluateUpdatedToken() {
            return { emitted: 0, events: [] };
          },
        },
      });

      assert.equal(result.skipReason, undefined);
      assert.equal(result.summary.gmgnNewNonPumpHighLaunchMcapAutoBlocked, 0);
      assert.equal(blockWrites.length, 0);
    }
  });

  it('auto-blocks young extreme GMGN tokens when token info shows low mcap with too many holders', async () => {
    const blockWrites = [];
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(),
      tokenCreatedAt: '2026-05-03T04:45:00.000Z',
      mcap: 83734.1,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('GMGN info block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('brand-new GMGN info block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked GMGN info risk tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          return {
            address: TOKEN_A,
            top10HolderRate: 0.0866,
          };
        },
        async fetchTokenInfo(request) {
          assert.equal(request.address, TOKEN_A);
          return {
            address: TOKEN_A,
            holderCount: 2001,
            marketCap: 84034,
          };
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked GMGN info risk tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-info-auto-blocked');
    assert.equal(result.summary.gmgnSecurityChecks, 1);
    assert.equal(result.summary.gmgnSecurityAutoBlocked, 0);
    assert.equal(result.summary.gmgnInfoChecks, 1);
    assert.equal(result.summary.gmgnInfoAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].address, TOKEN_A);
    assert.equal(blockWrites[0].label, 'gmgn-info:low-mcap-high-holders:84034:2001');
  });

  it('auto-blocks young extreme GMGN tokens with staircase pump kline pattern', async () => {
    const blockWrites = [];
    const candles = Array.from({ length: 20 }, (_, index) => {
      const open = index === 0 ? 0.000036 : 0.000036 * (1.06 ** index);
      const close = index < 18 ? open * 1.06 : open * 0.995;
      return {
        timestampMs: Date.parse('2026-05-03T06:40:00.000Z') + (index * 60000),
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 80000,
      };
    });

    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createYoungExtremeGmgnSnapshot(),
      tokenCreatedAt: '2026-05-03T06:39:00.000Z',
      mcap: 104000,
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add(payload) {
          blockWrites.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken() {
          throw new Error('GMGN kline block must happen before catalog upsert');
        },
        async applyEvaluationResult() {
          throw new Error('brand-new GMGN kline block must happen before catalog evaluation');
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('blocked GMGN kline risk tokens must not write buckets');
        },
      },
      gmgnClient: {
        async fetchTokenSecurity() {
          return { address: TOKEN_A, top10HolderRate: 0.22 };
        },
        async fetchTokenInfo() {
          return { address: TOKEN_A, holderCount: 1060, marketCap: 104000 };
        },
        async fetchMarketKline(request) {
          assert.equal(request.resolution, '1m');
          assert.equal(request.from, Date.parse('2026-05-03T06:38:00.000Z') / 1000);
          assert.equal(request.to, Date.parse('2026-05-03T07:00:00.000Z') / 1000);
          return candles;
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('blocked GMGN kline risk tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, 'gmgn-kline-auto-blocked');
    assert.equal(result.summary.gmgnKlineChecks, 1);
    assert.equal(result.summary.gmgnKlineAutoBlocked, 1);
    assert.equal(blockWrites.length, 1);
    assert.equal(blockWrites[0].address, TOKEN_A);
    assert.match(blockWrites[0].label, /^gmgn-kline:staircase-pump:/);
    assert.equal(result.gmgnKlineAnalysis.candleCount, 20);
  });

  it('falls back to quarantine when GMGN token security check fails', async () => {
    const result = await gmgnCatalogIngestion.ingestGmgnToken(createYoungExtremeGmgnSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress() {
          return null;
        },
        async upsertToken(payload) {
          return { address: payload.address, source: payload.source };
        },
        async applyEvaluationResult(address, payload) {
          return {
            address,
            source: 'gmgn',
            eligible_for_monitoring: payload.eligibleForMonitoring,
            suppressed_reason: payload.suppressedReason,
            last_vol_5m: payload.vol5m,
          };
        },
      },
      volumeBucketModel: { async upsertSnapshotBucket() { return {}; } },
      gmgnClient: {
        async fetchTokenSecurity() {
          throw new Error('gmgn unavailable');
        },
        async fetchTokenInfo() {
          return {
            address: TOKEN_A,
            holderCount: 500,
            marketCap: 100000,
          };
        },
        async fetchMarketKline() {
          return [];
        },
      },
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('suppressed GMGN risk enrichment tokens must not alert');
        },
      },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.gmgnSecurityChecks, 1);
    assert.equal(result.summary.gmgnSecurityAutoBlocked, 0);
    assert.equal(result.summary.gmgnSecurityErrors, 1);
    assert.equal(result.summary.gmgnInfoChecks, 1);
    assert.equal(result.summary.gmgnInfoAutoBlocked, 0);
    assert.equal(result.summary.riskEnrichmentSuppressed, 1);
    assert.match(result.summary.errorMessages[0], /GMGN security check failed/);
  });

  it('does not auto-block manual tokens from GMGN junk guard', async () => {
    let blockCalls = 0;
    let upsertCalls = 0;

    const result = await gmgnCatalogIngestion.ingestGmgnToken(createHighConfidenceJunkSnapshot(), {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      adminBlockedTokenModel: {
        async add() {
          blockCalls += 1;
        },
      },
      tokenCatalogModel: {
        async getByAddress(address) {
          return { address, source: 'user-manual' };
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult(address, payload) {
          return { address, source: 'user-manual', last_vol_5m: payload.vol5m };
        },
      },
      volumeBucketModel: { async upsertSnapshotBucket() { return {}; } },
      alertMatcher: { async evaluateUpdatedToken() { return {}; } },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.autoBlockedJunk, 0);
    assert.equal(blockCalls, 0);
    assert.equal(upsertCalls, 1);
  });

  it('still refreshes existing tokens when they appear only in GMGN 1m trending', async () => {
    let upsertCalls = 0;
    const result = await gmgnCatalogIngestion.ingestGmgnToken({
      ...createSnapshot(),
      gmgnInterval: '1m',
      gmgnIntervals: ['1m'],
    }, {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress(address) {
          return { address, source: 'dexscreener-discovery' };
        },
        async upsertToken() {
          upsertCalls += 1;
        },
        async applyEvaluationResult(address, payload) {
          return { address, source: 'gmgn', last_vol_5m: payload.vol5m };
        },
      },
      volumeBucketModel: { async upsertSnapshotBucket() { return {}; } },
      alertMatcher: { async evaluateUpdatedToken() { return {}; } },
    });

    assert.equal(result.skipped, undefined);
    assert.equal(result.summary.skipped1mOnlyDiscovery, 0);
    assert.equal(upsertCalls, 1);
  });

  it('does not keep admin-blocked GMGN refreshes active in the GMGN panel', async () => {
    const result = await gmgnCatalogIngestion.ingestGmgnTokens([
      {
        ...createSnapshot(),
        mcap: 104673,
        vol1m: 147067,
        vol5m: 759886,
        vol1h: 7820030,
        vol24h: 7752920,
        tokenCreatedAt: '2026-05-03T06:30:00.000Z',
        gmgnInterval: '1m',
        gmgnIntervals: ['1m'],
      },
    ], {
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      tokenCatalogModel: {
        async getByAddress(address) {
          return {
            address,
            source: 'admin-blocked',
            eligible_for_monitoring: false,
            suppressed_reason: 'admin_blocked',
          };
        },
        async upsertToken(payload) {
          return { address: payload.address, source: 'admin-blocked' };
        },
        async applyEvaluationResult(address, payload) {
          return {
            address,
            source: 'admin-blocked',
            eligible_for_monitoring: false,
            suppressed_reason: 'admin_blocked',
            last_vol_5m: payload.vol5m,
          };
        },
      },
      volumeBucketModel: {
        async upsertSnapshotBucket() {
          throw new Error('admin-blocked GMGN refreshes must not write buckets');
        },
      },
      gmgnClient: createSafeGmgnSecurityStub(),
      alertMatcher: {
        async evaluateUpdatedToken() {
          throw new Error('admin-blocked GMGN refreshes must not alert');
        },
      },
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].skipped, undefined);
    assert.equal(result.acceptedTokens.length, 0);
    assert.equal(result.catalogUpdated, 1);
    assert.equal(result.volumeBucketsWritten, 0);
    assert.equal(result.matcherEvaluations, 0);
  });

  it('runs a discovery ingestion cycle and applies panel state only after a complete GMGN cycle', async () => {
    let panelCalls = 0;
    const scheduler = {
      async runOnce() {
        return {
          skipped: false,
          rateLimited: false,
          errors: [],
          uniqueTokens: [createSnapshot(TOKEN_A), createSnapshot(TOKEN_B)],
        };
      },
    };
    const panelStateManager = {
      async applyPanelCycle(tokens) {
        panelCalls += 1;
        assert.deepEqual(tokens.map((token) => token.address), [TOKEN_A, TOKEN_B]);
        return { seenCount: 2, staleCount: 0, handoffCount: 0 };
      },
    };

    const result = await gmgnCatalogIngestion.runGmgnDiscoveryIngestionCycle({
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      scheduler,
      panelStateManager,
      tokenCatalogModel: createTokenCatalogStub(),
      volumeBucketModel: { async upsertSnapshotBucket() { return {}; } },
      alertMatcher: { async evaluateUpdatedToken() { return {}; } },
    });

    assert.equal(result.ingestion.processed, 2);
    assert.equal(result.panel.seenCount, 2);
    assert.equal(result.panelSkippedReason, null);
    assert.equal(panelCalls, 1);
  });

  it('skips stale panel processing when the GMGN cycle is incomplete', async () => {
    let panelCalls = 0;
    const result = await gmgnCatalogIngestion.runGmgnDiscoveryIngestionCycle({
      now: () => new Date('2026-05-03T07:00:00.000Z'),
      evaluationState: new Map(),
      scheduler: {
        async runOnce() {
          return {
            skipped: false,
            rateLimited: true,
            errors: [{ error: { code: 'GMGN_RATE_LIMIT' } }],
            uniqueTokens: [createSnapshot(TOKEN_A)],
          };
        },
      },
      panelStateManager: {
        async applyPanelCycle() {
          panelCalls += 1;
          return {};
        },
      },
      tokenCatalogModel: createTokenCatalogStub(),
      volumeBucketModel: { async upsertSnapshotBucket() { return {}; } },
      alertMatcher: { async evaluateUpdatedToken() { return {}; } },
    });

    assert.equal(result.ingestion.processed, 1);
    assert.equal(result.panel, null);
    assert.equal(result.panelSkippedReason, 'incomplete-gmgn-cycle');
    assert.equal(panelCalls, 0);
  });
});
