const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const alertDeliveryCursor = require('../src/models/alert-delivery-cursor');
const alertEventDismissal = require('../src/models/alert-event-dismissal');
const gmgnClaimAlertEvent = require('../src/models/gmgn-claim-alert-event');
const tokenCatalog = require('../src/models/token-catalog');
const tokenMeteoraState = require('../src/models/token-meteora-state');
const userAlertEvent = require('../src/models/user-alert-event');
const backendAlertFeed = require('../src/services/backend-alert-feed');

describe('backend alert feed service', () => {
  it('rejects unsupported dashboard alert rule keys early', async () => {
    await assert.rejects(
      () => backendAlertFeed.listDashboardAlertEvents({ ruleKey: 'unsupported-rule' }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED_ALERT_RULE');
        return true;
      }
    );
    await assert.rejects(
      () => backendAlertFeed.updateDashboardAlertCursor(7, {
        ruleKey: 'custom-alert', chain: 'base', lastSeenEventId: 1,
      }),
      (error) => error.code === 'UNSUPPORTED_ALERT_CHAIN',
    );
    await assert.rejects(
      () => backendAlertFeed.clearDashboardAlertFeeds(7, { chains: [] }),
      (error) => error.code === 'UNSUPPORTED_ALERT_CHAIN',
    );
  });

  it('lists user-configurable chart alerts from the last 24 hours without catalog lookups', async () => {
    const originalListChartEvents = userAlertEvent.listChartEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    let capturedFilters = null;

    userAlertEvent.listChartEvents = async (filters) => {
      capturedFilters = filters;
      return [{
        id: 71,
        userId: 8,
        ruleKey: 'monitored-mcap',
        kind: 'monitored-mcap',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        payload: {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          mcap: 100000,
          prevMcap: 80000,
          pct: 25,
          label: 'MCAP',
        },
        triggeredAt: '2026-07-03T05:47:42.000Z',
      }];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => {
      throw new Error('chart history must use the persisted event snapshot');
    };

    try {
      const payload = await backendAlertFeed.listDashboardChartAlertEvents({
        userId: 8,
        tokenAddress: 'So11111111111111111111111111111111111111112',
        now: new Date('2026-07-03T06:00:00.000Z'),
      });

      assert.equal(capturedFilters.userId, 8);
      assert.equal(capturedFilters.chain, 'solana');
      assert.equal(capturedFilters.tokenAddress, 'So11111111111111111111111111111111111111112');
      assert.equal(capturedFilters.triggeredAfter.toISOString(), '2026-07-02T06:00:00.000Z');
      assert.deepEqual(capturedFilters.ruleKeys, backendAlertFeed.CHART_ALERT_RULE_KEYS);
      assert.equal(capturedFilters.limit, 501);
      assert.equal(payload.generatedAt, '2026-07-03T06:00:00.000Z');
      assert.equal(payload.windowHours, 24);
      assert.equal(payload.count, 1);
      assert.equal(payload.truncated, false);
      assert.equal(payload.events[0].chain, 'solana');
      assert.equal(payload.events[0].mcap, 100000);
      assert.equal(payload.events[0].triggeredAt, '2026-07-03T05:47:42.000Z');
    } finally {
      userAlertEvent.listChartEvents = originalListChartEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
    }
  });

  it('uses GMGN claim payload metadata when catalog metadata is missing', async () => {
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;

    tokenCatalog.listDashboardMetadataByAddresses = async () => [];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.buildDashboardAlertEventFromEvent({
        id: 44,
        ruleKey: 'gmgn-claim-signal',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        signalType: 18,
        claimSequence: 1,
        claimId: 'gmgn-signal-1',
        totalFeeUsd: 12.34,
        claimedAt: '2026-05-04T04:13:00.000Z',
        triggeredAt: '2026-05-04T04:13:05.000Z',
        payload: {
          data: {
            symbol: 'PUMP',
            name: 'Pump Example',
            logo: 'https://example.com/pump.png',
            pool_address: 'pair_claim_1',
            quote_address: 'So11111111111111111111111111111111111111112',
            created_timestamp: 1777864380,
            total_fee: 12.34,
            claim_fee_sol_amount: '0.123456',
            usd_market_cap: 45613.52,
            volume_1h: 123,
            volume_6h: 456,
            volume_24h: 789,
          },
        },
      });

      assert.equal(payload.kind, 'gmgn-claim-signal');
      assert.equal(payload.chain, 'solana');
      assert.equal(payload.address, 'So11111111111111111111111111111111111111112');
      assert.equal(payload.symbol, 'PUMP');
      assert.equal(payload.name, 'Pump Example');
      assert.equal(payload.imageUrl, 'https://example.com/pump.png');
      assert.equal(payload.pairAddress, 'pair_claim_1');
      assert.equal(payload.tokenCreatedAt, 1777864380000);
      assert.equal(payload.claimFeeAmount, 0.123456);
      assert.equal(payload.claimFeeCurrency, 'SOL');
      assert.equal(payload.claimFeeUsd, null);
      assert.equal(payload.quoteAddress, 'So11111111111111111111111111111111111111112');
      assert.equal(payload.totalFeeUsd, null);
      assert.equal(payload.mcap, 45613.52);
      assert.equal(payload.volume1h, 123);
      assert.equal(payload.volume6h, 456);
      assert.equal(payload.volume24h, 789);
    } finally {
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('maps custom alert event payload fields for dashboard feeds', async () => {
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;

    tokenCatalog.listDashboardMetadataByAddresses = async () => [{
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      last_mcap: 260000,
      last_price: 0.00011,
    }];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.buildDashboardAlertEventFromEvent({
        id: 45,
        userId: 7,
        ruleKey: 'custom-alert',
        kind: 'custom-alert',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        payload: {
          address: 'So11111111111111111111111111111111111111112',
          customRuleId: 12,
          customTitle: 'Mcap target',
          customMetric: 'Market Cap',
          customOperator: 'crosses above',
          customTarget: 250000,
          customColorHex: '#22c55e',
          customSoundDataUrl: 'data:audio/mpeg;base64,SUQzBAAAAAAA',
          customCurrentValue: 260000,
          customPreviousValue: 240000,
          mcap: 260000,
          label: 'CUSTOM',
        },
        triggeredAt: '2026-07-06T06:00:00.000Z',
      });

      assert.equal(payload.kind, 'custom-alert');
      assert.equal(payload.ruleKey, 'custom-alert');
      assert.equal(payload.symbol, 'WSOL');
      assert.equal(payload.customRuleId, 12);
      assert.equal(payload.customTitle, 'Mcap target');
      assert.equal(payload.customMetric, 'Market Cap');
      assert.equal(payload.customOperator, 'crosses above');
      assert.equal(payload.customTarget, 250000);
      assert.equal(payload.customColorHex, '#22c55e');
      assert.equal(payload.customSoundDataUrl, 'data:audio/mpeg;base64,SUQzBAAAAAAA');
      assert.equal(payload.customCurrentValue, 260000);
      assert.equal(payload.customPreviousValue, 240000);
      assert.equal(payload.mcap, 260000);
    } finally {
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('suppresses historical replay for realtime-only GMGN claim alerts', async () => {
    const originalGetLatestEventId = gmgnClaimAlertEvent.getLatestEventId;
    const originalListRecentEvents = gmgnClaimAlertEvent.listRecentEvents;
    const originalMarkSeen = alertDeliveryCursor.markSeen;
    let capturedLatestFilters = null;
    let capturedMarkSeenArgs = null;

    gmgnClaimAlertEvent.getLatestEventId = async (filters) => {
      capturedLatestFilters = filters;
      return 88;
    };
    gmgnClaimAlertEvent.listRecentEvents = async () => {
      throw new Error('GMGN claim historical events must not replay through dashboard feed');
    };
    alertDeliveryCursor.markSeen = async (userId, ruleKey, lastSeenEventId, chain) => {
      capturedMarkSeenArgs = [userId, ruleKey, lastSeenEventId, chain];
      return {
        userId,
        ruleKey,
        lastSeenEventId,
        lastAckedEventId: null,
        updatedAt: '2026-05-04T04:13:05.000Z',
      };
    };

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 12,
        ruleKey: 'gmgn-claim-signal',
        mode: 'all',
        limit: 50,
      });

      assert.deepEqual(capturedLatestFilters, { ruleKey: 'gmgn-claim-signal' });
      assert.deepEqual(capturedMarkSeenArgs, [12, 'gmgn-claim-signal', 88, 'solana']);
      assert.equal(payload.ruleKey, 'gmgn-claim-signal');
      assert.equal(payload.kind, 'gmgn-claim-signal');
      assert.equal(payload.mode, 'all');
      assert.equal(payload.count, 0);
      assert.deepEqual(payload.events, []);
      assert.deepEqual(payload.cursor, {
        ruleKey: 'gmgn-claim-signal',
        chain: 'solana',
        lastSeenEventId: 88,
        lastAckedEventId: null,
        updatedAt: '2026-05-04T04:13:05.000Z',
      });
    } finally {
      gmgnClaimAlertEvent.getLatestEventId = originalGetLatestEventId;
      gmgnClaimAlertEvent.listRecentEvents = originalListRecentEvents;
      alertDeliveryCursor.markSeen = originalMarkSeen;
    }
  });

  it('builds a dashboard payload for per-user backend alert rules from persisted user events', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedFilters = null;

    alertDeliveryCursor.getCursor = async () => null;
    userAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [{
        id: 31,
        userId: 7,
        ruleKey: 'monitored-vol',
        kind: 'monitored-vol',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        payload: {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          label: 'VOL',
          pct: 80,
          prevVolume1m: 6000,
          volume1m: 9000,
          prevVolume5m: 10000,
          volume5m: 18000,
          volume1h: 50000,
          volume6h: 120000,
          volume24h: 350000,
          prevMcap: 250000,
          mcap: 300000,
          tickerPeers: {
            chain: 'solana',
            sourceSymbol: 'WSOL',
            normalizedSymbol: 'WSOL',
            count: 2,
            exactCount: 1,
            subtickerCount: 1,
            items: [
              {
                address: 'So11111111111111111111111111111111111111112',
                symbol: 'WSOL',
                mcap: 300000,
                ageMsAtAlert: 3600000,
                matchType: 'exact',
              },
              {
                address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
                symbol: 'WSOL',
                mcap: 120000,
                ageMsAtAlert: 7200000,
                matchType: 'subticker',
              },
            ],
            hasSubtickerMatch: true,
            sourcePeerRole: 'peer_warning',
          },
        },
        triggeredAt: new Date('2026-04-16T12:05:10.000Z'),
      }];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => [{
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      last_pair_address: 'pair_test_123',
      last_pair_url: 'https://dexscreener.com/solana/testpair',
      last_image_url: 'https://example.com/token.png',
      last_twitter_url: 'https://x.com/wsol',
      last_mcap: '300000',
      last_vol_1h: '50000',
      last_vol_6h: '120000',
      last_vol_24h: '350000',
      last_token_created_at_ms: String(Date.UTC(2026, 3, 1, 12, 0, 0)),
    }];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 7,
        ruleKey: 'monitored-vol',
        limit: 20,
      });

      assert.deepEqual(capturedFilters, {
        userId: 7,
        chain: 'solana',
        ruleKey: 'monitored-vol',
        limit: 20,
        afterId: null,
        sort: 'desc',
        dismissedByUserId: 7,
      });
      assert.equal(payload.ruleKey, 'monitored-vol');
      assert.equal(payload.kind, 'monitored-vol');
      assert.equal(payload.count, 1);
      assert.equal(payload.events[0].chain, 'solana');
      assert.equal(payload.events[0].label, 'VOL');
      assert.equal(payload.events[0].tickerPeers?.count, 2);
      assert.equal(payload.events[0].tickerPeers?.chain, 'solana');
      assert.equal(payload.events[0].tickerPeers?.hasSubtickerMatch, true);
      assert.equal(payload.events[0].tickerPeers?.sourcePeerRole, 'peer_warning');
      assert.equal(payload.events[0].tickerPeers?.subtickerCount, 1);
      assert.equal(payload.events[0].pct, 80);
      assert.equal(payload.events[0].prevVolume1m, 6000);
      assert.equal(payload.events[0].volume1m, 9000);
      assert.equal(payload.events[0].prevVolume5m, 10000);
      assert.equal(payload.events[0].volume5m, 18000);
      assert.equal(payload.events[0].mcap, 300000);
      assert.equal(payload.events[0].triggeredAt, '2026-04-16T12:05:10.000Z');
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('lists all dashboard-enabled alert feeds for the authenticated user', async () => {
    const originalListDashboardAlertEvents = backendAlertFeed.listDashboardAlertEvents;
    const capturedRuleKeys = [];

    backendAlertFeed.listDashboardAlertEvents = async (options) => {
      capturedRuleKeys.push(options.ruleKey);
      return {
        generatedAt: '2026-04-16T12:05:10.000Z',
        kind: options.ruleKey,
        ruleKey: options.ruleKey,
        mode: options.mode || 'all',
        cursor: {
          ruleKey: options.ruleKey,
          lastSeenEventId: null,
          lastAckedEventId: null,
          updatedAt: null,
        },
        count: options.ruleKey === 'monitored-vol' ? 1 : 0,
        events: options.ruleKey === 'monitored-vol'
          ? [{ id: 9, kind: 'monitored-vol', ruleKey: 'monitored-vol', address: 'So11111111111111111111111111111111111111112' }]
          : [],
      };
    };

    try {
      const payload = await backendAlertFeed.listDashboardAlertFeeds({
        userId: 7,
        limit: 10,
        mode: 'unseen',
      });

      assert.deepEqual(capturedRuleKeys, [
        'gmgn-claim-signal',
        'monitored-vol',
        'gmgn-vol-1m',
        'monitored-mcap',
        'hvnc',
        'recent-surge-1h',
        'recent-surge-6h',
        'old-week-surge-1h',
        'old-week-surge-6h',
        'surge-continuation-6h',
        'meteora-surge',
        'custom-alert',
        'robinhood-hvnc-v2',
      ]);
      assert.equal(payload.mode, 'unseen');
      assert.equal(payload.count, 1);
      assert.equal(payload.feeds.length, 13);
    } finally {
      backendAlertFeed.listDashboardAlertEvents = originalListDashboardAlertEvents;
    }
  });

  it('keeps Robinhood HVNC feed queries and valuation metadata chain-aware', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    const address = '0xabcdef0123456789abcdef0123456789abcdef01';
    let capturedEventFilters = null;
    let capturedCatalogOptions = null;

    alertDeliveryCursor.getCursor = async () => null;
    userAlertEvent.listRecentEvents = async (filters) => {
      capturedEventFilters = filters;
      return [{
        id: 90,
        userId: 7,
        chain: 'robinhood',
        ruleKey: 'robinhood-hvnc-v2',
        kind: 'hvnc',
        tokenAddress: address,
        payload: {
          chain: 'robinhood',
          address,
          symbol: 'RHV',
          fdv: 500000,
          mcap: null,
          priceUsd: 0.0042,
          liquidityUsd: 5000,
          transactions: 15,
          volume5m: 2000,
          isHvnc: true,
          label: 'HVNC',
        },
        triggeredAt: '2026-07-14T06:00:00.000Z',
      }];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async (_addresses, options) => {
      capturedCatalogOptions = options;
      return [{ chain: 'robinhood', address, last_fdv: '500000' }];
    };
    tokenMeteoraState.listSummaryByAddresses = async () => {
      throw new Error('Robinhood feed must not load Solana Meteora state');
    };

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 7,
        ruleKey: 'robinhood-hvnc-v2',
        limit: 20,
      });

      assert.deepEqual(capturedEventFilters, {
        userId: 7,
        chain: 'robinhood',
        ruleKey: 'robinhood-hvnc-v2',
        limit: 20,
        afterId: null,
        sort: 'desc',
        dismissedByUserId: 7,
      });
      assert.deepEqual(capturedCatalogOptions, { chain: 'robinhood' });
      assert.equal(payload.count, 1);
      assert.equal(payload.events[0].chain, 'robinhood');
      assert.equal(payload.events[0].mcap, null);
      assert.equal(payload.events[0].fdv, 500000);
      assert.equal(payload.events[0].valuationType, 'fdv');
      assert.equal(payload.events[0].priceUsd, 0.0042);
      assert.equal(payload.events[0].liquidityUsd, 5000);
      assert.equal(payload.events[0].transactions, 15);
      assert.equal(payload.events[0].volume5m, 2000);
      assert.equal(payload.events[0].junkAssessment, null);
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('merges Solana and Robinhood custom alerts without collapsing chain identity', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    const solanaAddress = 'So11111111111111111111111111111111111111112';
    const robinhoodAddress = '0xabcdef0123456789abcdef0123456789abcdef01';
    const cursorChains = [];
    const eventFilters = [];
    const metadataChains = [];

    alertDeliveryCursor.getCursor = async (_userId, _ruleKey, chain) => {
      cursorChains.push(chain);
      return {
        chain,
        lastSeenEventId: chain === 'solana' ? 81 : 90,
        lastAckedEventId: chain === 'solana' ? 80 : 89,
      };
    };
    userAlertEvent.listRecentEvents = async (filters) => {
      eventFilters.push(filters);
      const robinhood = filters.chain === 'robinhood';
      return [{
        id: robinhood ? 92 : 91,
        userId: 7,
        chain: filters.chain,
        ruleKey: 'custom-alert',
        kind: 'custom-alert',
        tokenAddress: robinhood ? robinhoodAddress : solanaAddress,
        payload: robinhood
          ? { chain: 'robinhood', address: robinhoodAddress, fdv: 500000, mcap: null }
          : { chain: 'solana', address: solanaAddress, mcap: 300000 },
        triggeredAt: '2026-07-14T18:00:00.000Z',
      }];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async (addresses, options) => {
      metadataChains.push(options.chain);
      return addresses.map((address) => ({ chain: options.chain, address }));
    };
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 7, ruleKey: 'custom-alert', limit: 20, mode: 'all',
      });

      assert.deepEqual(cursorChains, ['solana', 'robinhood']);
      assert.deepEqual(eventFilters.map(({ chain, afterId }) => ({ chain, afterId })), [
        { chain: 'solana', afterId: 80 },
        { chain: 'robinhood', afterId: 89 },
      ]);
      assert.deepEqual(metadataChains.sort(), ['robinhood', 'solana']);
      assert.equal(payload.cursor, null);
      assert.deepEqual(payload.cursors.map((cursor) => cursor.chain), ['solana', 'robinhood']);
      assert.deepEqual(payload.events.map((event) => event.id), [92, 91]);
      assert.equal(payload.events[0].chain, 'robinhood');
      assert.equal(payload.events[0].mcap, null);
      assert.equal(payload.events[0].fdv, 500000);
      assert.equal(payload.events[1].chain, 'solana');
      assert.equal(payload.events[1].mcap, 300000);
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('builds a dashboard payload for surge backend events with age bucket metadata', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;

    alertDeliveryCursor.getCursor = async () => null;
    userAlertEvent.listRecentEvents = async () => [{
      id: 44,
      userId: 7,
      ruleKey: 'recent-surge-1h',
      kind: 'old-surge',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      payload: {
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'WSOL',
        label: 'PCHANGE 1H',
        pct: 32,
        priceChange1h: 32,
        priceChange6h: 110,
        prevMcap: 227272.73,
        mcap: 300000,
        thresholdPct: 25,
        surgeWindow: '1H',
        ageBucket: 'recent',
        isOldSurge: true,
      },
      triggeredAt: '2026-04-16T12:05:10.000Z',
    }];
    tokenCatalog.listDashboardMetadataByAddresses = async () => [{
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      last_pair_address: 'pair_test_123',
      last_pair_url: 'https://dexscreener.com/solana/testpair',
      last_image_url: 'https://example.com/token.png',
      last_twitter_url: 'https://x.com/wsol',
      last_mcap: '300000',
      last_price_change_1h: '32',
      last_price_change_6h: '110',
      last_vol_1h: '50000',
      last_vol_6h: '120000',
      last_vol_24h: '350000',
      last_token_created_at_ms: String(Date.UTC(2026, 3, 13, 12, 0, 0)),
    }];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 7,
        ruleKey: 'recent-surge-1h',
        limit: 20,
      });

      assert.equal(payload.ruleKey, 'recent-surge-1h');
      assert.equal(payload.kind, 'old-surge');
      assert.equal(payload.count, 1);
      assert.equal(payload.events[0].ruleKey, 'recent-surge-1h');
      assert.equal(payload.events[0].kind, 'old-surge');
      assert.equal(payload.events[0].surgeWindow, '1H');
      assert.equal(payload.events[0].ageBucket, 'recent');
      assert.equal(payload.events[0].thresholdPct, 25);
      assert.equal(payload.events[0].isOldSurge, true);
      assert.equal(payload.events[0].priceChange1h, 32);
      assert.equal(payload.events[0].priceChange6h, 110);
      assert.equal(payload.events[0].prevMcap, 227272.73);
      assert.equal(payload.events[0].mcap, 300000);
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('uses the per-user per-rule cursor when listing unseen dashboard alert events', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalGetLatestEventId = userAlertEvent.getLatestEventId;
    const originalMarkSeen = alertDeliveryCursor.markSeen;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedCursorArgs = null;
    let capturedFilters = null;

    alertDeliveryCursor.getCursor = async (userId, ruleKey, chain) => {
      capturedCursorArgs = [userId, ruleKey, chain];
      return {
        userId,
        ruleKey,
        lastSeenEventId: 21,
        lastAckedEventId: 19,
        updatedAt: '2026-04-05T18:15:00.000Z',
      };
    };
    userAlertEvent.getLatestEventId = async () => {
      throw new Error('should not bootstrap when cursor already exists');
    };
    alertDeliveryCursor.markSeen = async () => {
      throw new Error('should not mark seen when cursor already exists');
    };
    userAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => [];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 9,
        ruleKey: 'monitored-vol',
        mode: 'unseen',
        limit: 10,
      });

      assert.deepEqual(capturedCursorArgs, [9, 'monitored-vol', 'solana']);
      assert.deepEqual(capturedFilters, {
        userId: 9,
        chain: 'solana',
        ruleKey: 'monitored-vol',
        limit: 10,
        afterId: 21,
        sort: 'asc',
        dismissedByUserId: 9,
      });
      assert.equal(payload.mode, 'unseen');
      assert.equal(payload.cursor.lastSeenEventId, 21);
      assert.equal(payload.cursor.lastAckedEventId, 19);
      assert.equal(payload.count, 0);
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.getLatestEventId = originalGetLatestEventId;
      alertDeliveryCursor.markSeen = originalMarkSeen;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('uses the acked cursor to hide cleared dashboard alert events from the full feed', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedFilters = null;

    alertDeliveryCursor.getCursor = async (userId, ruleKey) => ({
      userId,
      ruleKey,
      lastSeenEventId: 35,
      lastAckedEventId: 33,
      updatedAt: '2026-04-05T18:15:00.000Z',
    });
    userAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => [];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 9,
        ruleKey: 'monitored-vol',
        mode: 'all',
        limit: 10,
      });

      assert.deepEqual(capturedFilters, {
        userId: 9,
        chain: 'solana',
        ruleKey: 'monitored-vol',
        limit: 10,
        afterId: 33,
        sort: 'desc',
        dismissedByUserId: 9,
      });
      assert.equal(payload.mode, 'all');
      assert.equal(payload.cursor.lastAckedEventId, 33);
      assert.equal(payload.count, 0);
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('bootstraps the per-user unseen cursor instead of replaying historical events for first-time viewers', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalGetLatestEventId = userAlertEvent.getLatestEventId;
    const originalMarkSeen = alertDeliveryCursor.markSeen;
    const originalListRecentEvents = userAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedLatestFilters = null;
    let capturedMarkSeenArgs = null;
    let capturedFilters = null;

    alertDeliveryCursor.getCursor = async () => null;
    userAlertEvent.getLatestEventId = async (filters) => {
      capturedLatestFilters = filters;
      return 59;
    };
    alertDeliveryCursor.markSeen = async (userId, ruleKey, lastSeenEventId, chain) => {
      capturedMarkSeenArgs = [userId, ruleKey, lastSeenEventId, chain];
      return {
        userId,
        ruleKey,
        lastSeenEventId,
        lastAckedEventId: null,
        updatedAt: '2026-04-07T08:09:24.867Z',
      };
    };
    userAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => [];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 4,
        ruleKey: 'monitored-vol',
        mode: 'unseen',
        limit: 50,
      });

      assert.deepEqual(capturedLatestFilters, {
        userId: 4,
        chain: 'solana',
        ruleKey: 'monitored-vol',
      });
      assert.deepEqual(capturedMarkSeenArgs, [4, 'monitored-vol', 59, 'solana']);
      assert.deepEqual(capturedFilters, {
        userId: 4,
        chain: 'solana',
        ruleKey: 'monitored-vol',
        limit: 50,
        afterId: 59,
        sort: 'asc',
        dismissedByUserId: 4,
      });
      assert.equal(payload.mode, 'unseen');
      assert.equal(payload.count, 0);
      assert.deepEqual(payload.cursor, {
        ruleKey: 'monitored-vol',
        chain: 'solana',
        lastSeenEventId: 59,
        lastAckedEventId: null,
        updatedAt: '2026-04-07T08:09:24.867Z',
      });
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.getLatestEventId = originalGetLatestEventId;
      alertDeliveryCursor.markSeen = originalMarkSeen;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('updates the per-user per-rule dashboard alert cursor through the service layer', async () => {
    const originalUpsertCursor = alertDeliveryCursor.upsertCursor;
    let capturedPayload = null;

    alertDeliveryCursor.upsertCursor = async (payload) => {
      capturedPayload = payload;
      return {
        userId: payload.userId,
        ruleKey: payload.ruleKey,
        lastSeenEventId: payload.lastSeenEventId,
        lastAckedEventId: payload.lastAckedEventId,
        updatedAt: '2026-04-05T18:20:00.000Z',
      };
    };

    try {
      const cursor = await backendAlertFeed.updateDashboardAlertCursor(9, {
        ruleKey: 'custom-alert',
        chain: 'robinhood',
        lastSeenEventId: 31,
      });

      assert.deepEqual(capturedPayload, {
        userId: 9,
        ruleKey: 'custom-alert',
        chain: 'robinhood',
        lastSeenEventId: 31,
        lastAckedEventId: undefined,
      });
      assert.deepEqual(cursor, {
        ruleKey: 'custom-alert',
        chain: 'robinhood',
        lastSeenEventId: 31,
        lastAckedEventId: null,
        updatedAt: '2026-04-05T18:20:00.000Z',
      });
    } finally {
      alertDeliveryCursor.upsertCursor = originalUpsertCursor;
    }
  });

  it('clears only the selected chain for a multi-chain alert rule', async () => {
    const originalGetLatestEventId = userAlertEvent.getLatestEventId;
    const originalUpsertCursor = alertDeliveryCursor.upsertCursor;
    const capturedLatestFilters = [];
    const capturedCursorPayloads = [];

    userAlertEvent.getLatestEventId = async (filters) => {
      capturedLatestFilters.push(filters);
      return 72;
    };
    alertDeliveryCursor.upsertCursor = async (payload) => {
      capturedCursorPayloads.push(payload);
      return {
        userId: payload.userId,
        ruleKey: payload.ruleKey,
        lastSeenEventId: payload.lastSeenEventId,
        lastAckedEventId: payload.lastAckedEventId,
        updatedAt: '2026-04-05T18:25:00.000Z',
      };
    };

    try {
      const payload = await backendAlertFeed.clearDashboardAlertFeeds(9, {
        ruleKeys: ['custom-alert'],
        chains: ['solana'],
      });

      assert.deepEqual(capturedLatestFilters, [{
        userId: 9,
        chain: 'solana',
        ruleKey: 'custom-alert',
      }]);
      assert.deepEqual(capturedCursorPayloads, [{
        userId: 9,
        ruleKey: 'custom-alert',
        chain: 'solana',
        lastSeenEventId: 72,
        lastAckedEventId: 72,
      }]);
      assert.equal(payload.count, 1);
      assert.deepEqual(payload.cursors[0], {
        ruleKey: 'custom-alert',
        chain: 'solana',
        lastSeenEventId: 72,
        lastAckedEventId: 72,
        updatedAt: '2026-04-05T18:25:00.000Z',
      });
    } finally {
      userAlertEvent.getLatestEventId = originalGetLatestEventId;
      alertDeliveryCursor.upsertCursor = originalUpsertCursor;
    }
  });

  it('persists one dismissal only after validating event ownership and chain', async () => {
    const originalGetEventForUser = userAlertEvent.getEventForUser;
    const originalDismissEvent = alertEventDismissal.dismissEvent;
    let capturedLookup = null;
    let capturedDismissal = null;
    userAlertEvent.getEventForUser = async (eventId, userId) => {
      capturedLookup = [eventId, userId];
      return { id: eventId, userId, ruleKey: 'custom-alert', chain: 'robinhood' };
    };
    alertEventDismissal.dismissEvent = async (payload) => {
      capturedDismissal = payload;
      return { ...payload, dismissedAt: '2026-07-16T12:00:00.000Z' };
    };

    try {
      const dismissal = await backendAlertFeed.dismissDashboardAlertEvent(7, {
        ruleKey: 'custom-alert', chain: 'robinhood', eventId: 91,
      });
      assert.deepEqual(capturedLookup, [91, 7]);
      assert.deepEqual(capturedDismissal, {
        userId: 7, ruleKey: 'custom-alert', chain: 'robinhood', eventId: 91,
      });
      assert.equal(dismissal.eventId, 91);

      await assert.rejects(
        () => backendAlertFeed.dismissDashboardAlertEvent(7, {
          ruleKey: 'custom-alert', chain: 'solana', eventId: 91,
        }),
        (error) => error.code === 'ALERT_EVENT_NOT_FOUND',
      );
    } finally {
      userAlertEvent.getEventForUser = originalGetEventForUser;
      alertEventDismissal.dismissEvent = originalDismissEvent;
    }
  });
});
