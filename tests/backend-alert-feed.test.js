const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const alertDeliveryCursor = require('../src/models/alert-delivery-cursor');
const tokenAlertEvent = require('../src/models/token-alert-event');
const tokenCatalog = require('../src/models/token-catalog');
const tokenMeteoraState = require('../src/models/token-meteora-state');
const userAlertEvent = require('../src/models/user-alert-event');
const backendAlertFeed = require('../src/services/backend-alert-feed');

describe('backend alert feed service', () => {
  it('builds a dashboard payload for supported backend alert rules', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalListRecentEvents = tokenAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedFilters = null;
    let capturedAddresses = null;

    alertDeliveryCursor.getCursor = async () => null;
    tokenMeteoraState.listSummaryByAddresses = async () => [{
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hasPool: false,
      currentTvl: null,
      poolCount: 0,
    }];
    tokenAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [{
        id: 17,
        ruleKey: 'high-cap-dump-5m',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        baselineTs: '2026-04-05T18:00:00.000Z',
        baselineMcap: 8000000,
        windowLowMcap: 3200000,
        currentTs: '2026-04-05T18:05:00.000Z',
        currentCloseMcap: 4100000,
        dumpPct: -60,
        thresholdPct: 50,
        triggeredAt: '2026-04-05T18:05:05.000Z',
      }];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async (addresses) => {
      capturedAddresses = addresses;
      return [{
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        last_pair_address: 'pair_test_123',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_image_url: 'https://example.com/token.png',
        last_twitter_url: 'https://x.com/wsol',
        last_mcap: '4200000',
        last_price_change_6h: '5',
        last_price_change_24h: '12',
        monitor_priority: 'high',
        last_vol_1h: '200000',
        last_vol_6h: '900000',
        last_vol_24h: '3400000',
        last_token_created_at_ms: String(Date.UTC(2026, 3, 1, 12, 0, 0)),
        blocked_label: 'manual-junk-block',
        blocked_created_by: 9,
        blocked_created_at: '2026-04-09T11:00:00.000Z',
      }];
    };

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 7,
        ruleKey: 'high-cap-dump-5m',
        limit: 25,
      });

      assert.deepEqual(capturedFilters, { ruleKey: 'high-cap-dump-5m', limit: 25, afterId: null, sort: 'desc' });
      assert.deepEqual(capturedAddresses, ['So11111111111111111111111111111111111111112']);
      assert.equal(payload.ruleKey, 'high-cap-dump-5m');
      assert.equal(payload.kind, 'high-cap-dump-5m');
      assert.equal(payload.mode, 'all');
      assert.deepEqual(payload.cursor, {
        ruleKey: 'high-cap-dump-5m',
        lastSeenEventId: null,
        lastAckedEventId: null,
        updatedAt: null,
      });
      assert.equal(payload.count, 1);
      assert.equal(payload.events[0].kind, 'high-cap-dump-5m');
      assert.equal(payload.events[0].address, 'So11111111111111111111111111111111111111112');
      assert.equal(payload.events[0].symbol, 'WSOL');
      assert.equal(payload.events[0].dumpPct, -60);
      assert.equal(payload.events[0].blockStatus.label, 'blocked_manual');
      assert.equal(payload.events[0].effectiveRiskLabel, 'blocked_manual');
      assert.equal(payload.events[0].riskReview, null);
      assert.equal(payload.events[0].structuralRisk, null);
      assert.equal(payload.events[0].junkAssessment.label, 'valid_but_weak');
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      tokenAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('rejects unsupported dashboard alert rule keys early', async () => {
    await assert.rejects(
      () => backendAlertFeed.listDashboardAlertEvents({ ruleKey: 'unsupported-rule' }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED_ALERT_RULE');
        return true;
      }
    );
  });

  it('builds a single dashboard alert event payload for realtime delivery', async () => {
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedAddresses = null;

    tokenMeteoraState.listSummaryByAddresses = async () => [{
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hasPool: false,
      currentTvl: null,
      poolCount: 0,
    }];
    tokenCatalog.listDashboardMetadataByAddresses = async (addresses) => {
      capturedAddresses = addresses;
      return [{
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        last_pair_address: 'pair_test_123',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_image_url: 'https://example.com/token.png',
        last_twitter_url: 'https://x.com/wsol',
        last_mcap: '4200000',
        last_price_change_6h: '5',
        last_price_change_24h: '12',
        monitor_priority: 'high',
        last_vol_1h: '200000',
        last_vol_6h: '900000',
        last_vol_24h: '3400000',
        last_token_created_at_ms: String(Date.UTC(2026, 3, 1, 12, 0, 0)),
      }];
    };

    try {
      const payload = await backendAlertFeed.buildDashboardAlertEventFromEvent({
        id: 18,
        ruleKey: 'high-cap-dump-5m',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        baselineTs: '2026-04-05T18:00:00.000Z',
        baselineMcap: 8000000,
        windowLowMcap: 3200000,
        currentTs: '2026-04-05T18:05:00.000Z',
        currentCloseMcap: 4100000,
        dumpPct: -60,
        thresholdPct: 50,
        triggeredAt: '2026-04-05T18:05:05.000Z',
        metadata: {
          tickerPeers: {
            sourceSymbol: 'WSOL',
            normalizedSymbol: 'WSOL',
            count: 2,
            exactCount: 2,
            subtickerCount: 0,
            sourcePeerRole: 'mcap_leader',
            oldestExactAddress: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
            highestMcapExactAddress: 'So11111111111111111111111111111111111111112',
            items: [
              {
                address: 'So11111111111111111111111111111111111111112',
                symbol: 'WSOL',
                mcap: 4100000,
                ageMsAtAlert: 3600000,
                matchType: 'exact',
              },
              {
                address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
                symbol: 'WSOL',
                mcap: 120000,
                ageMsAtAlert: 7200000,
                matchType: 'exact',
              },
            ],
          },
        },
      });

      assert.deepEqual(capturedAddresses, ['So11111111111111111111111111111111111111112']);
      assert.equal(payload.id, 18);
      assert.equal(payload.kind, 'high-cap-dump-5m');
      assert.equal(payload.address, 'So11111111111111111111111111111111111111112');
      assert.equal(payload.symbol, 'WSOL');
      assert.equal(payload.dumpPct, -60);
      assert.equal(payload.tickerPeers?.count, 2);
      assert.equal(payload.tickerPeers?.sourcePeerRole, 'mcap_leader');
      assert.equal(payload.tickerPeers?.oldestExactAddress, '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb');
      assert.equal(payload.tickerPeers?.items?.[1]?.ageMsAtAlert, 7200000);
      assert.equal(payload.riskReview, null);
      assert.equal(payload.structuralRisk, null);
      assert.equal(payload.junkAssessment.label, 'valid_but_weak');
    } finally {
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
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
        triggeredAt: '2026-04-16T12:05:10.000Z',
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
        ruleKey: 'monitored-vol',
        limit: 20,
        afterId: null,
        sort: 'desc',
      });
      assert.equal(payload.ruleKey, 'monitored-vol');
      assert.equal(payload.kind, 'monitored-vol');
      assert.equal(payload.count, 1);
      assert.equal(payload.events[0].label, 'VOL');
      assert.equal(payload.events[0].tickerPeers?.count, 2);
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
        count: options.ruleKey === 'high-cap-dump-5m' ? 1 : 0,
        events: options.ruleKey === 'high-cap-dump-5m'
          ? [{ id: 9, kind: 'high-cap-dump-5m', ruleKey: 'high-cap-dump-5m', address: 'So11111111111111111111111111111111111111112' }]
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
        'high-cap-dump-5m',
        'monitored-vol',
        'gmgn-vol-1m',
        'monitored-mcap',
        'hvnc',
        'recent-surge-1h',
        'recent-surge-6h',
        'old-week-surge-1h',
        'old-week-surge-6h',
        'meteora-surge',
      ]);
      assert.equal(payload.mode, 'unseen');
      assert.equal(payload.count, 1);
      assert.equal(payload.feeds.length, 10);
    } finally {
      backendAlertFeed.listDashboardAlertEvents = originalListDashboardAlertEvents;
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
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      userAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('uses the per-user per-rule cursor when listing unseen dashboard alert events', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalGetLatestEventId = tokenAlertEvent.getLatestEventId;
    const originalMarkSeen = alertDeliveryCursor.markSeen;
    const originalListRecentEvents = tokenAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedCursorArgs = null;
    let capturedFilters = null;

    alertDeliveryCursor.getCursor = async (userId, ruleKey) => {
      capturedCursorArgs = [userId, ruleKey];
      return {
        userId,
        ruleKey,
        lastSeenEventId: 21,
        lastAckedEventId: 19,
        updatedAt: '2026-04-05T18:15:00.000Z',
      };
    };
    tokenAlertEvent.getLatestEventId = async () => {
      throw new Error('should not bootstrap when cursor already exists');
    };
    alertDeliveryCursor.markSeen = async () => {
      throw new Error('should not mark seen when cursor already exists');
    };
    tokenAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => [];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 9,
        ruleKey: 'high-cap-dump-5m',
        mode: 'unseen',
        limit: 10,
      });

      assert.deepEqual(capturedCursorArgs, [9, 'high-cap-dump-5m']);
      assert.deepEqual(capturedFilters, {
        ruleKey: 'high-cap-dump-5m',
        limit: 10,
        afterId: 21,
        sort: 'asc',
      });
      assert.equal(payload.mode, 'unseen');
      assert.equal(payload.cursor.lastSeenEventId, 21);
      assert.equal(payload.cursor.lastAckedEventId, 19);
      assert.equal(payload.count, 0);
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      tokenAlertEvent.getLatestEventId = originalGetLatestEventId;
      alertDeliveryCursor.markSeen = originalMarkSeen;
      tokenAlertEvent.listRecentEvents = originalListRecentEvents;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('bootstraps the per-user unseen cursor instead of replaying historical events for first-time viewers', async () => {
    const originalGetCursor = alertDeliveryCursor.getCursor;
    const originalGetLatestEventId = tokenAlertEvent.getLatestEventId;
    const originalMarkSeen = alertDeliveryCursor.markSeen;
    const originalListRecentEvents = tokenAlertEvent.listRecentEvents;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedLatestRuleKey = null;
    let capturedMarkSeenArgs = null;
    let capturedFilters = null;

    alertDeliveryCursor.getCursor = async () => null;
    tokenAlertEvent.getLatestEventId = async (filters) => {
      capturedLatestRuleKey = filters?.ruleKey || null;
      return 59;
    };
    alertDeliveryCursor.markSeen = async (userId, ruleKey, lastSeenEventId) => {
      capturedMarkSeenArgs = [userId, ruleKey, lastSeenEventId];
      return {
        userId,
        ruleKey,
        lastSeenEventId,
        lastAckedEventId: null,
        updatedAt: '2026-04-07T08:09:24.867Z',
      };
    };
    tokenAlertEvent.listRecentEvents = async (filters) => {
      capturedFilters = filters;
      return [];
    };
    tokenCatalog.listDashboardMetadataByAddresses = async () => [];
    tokenMeteoraState.listSummaryByAddresses = async () => [];

    try {
      const payload = await backendAlertFeed.listDashboardAlertEvents({
        userId: 4,
        ruleKey: 'high-cap-dump-5m',
        mode: 'unseen',
        limit: 50,
      });

      assert.equal(capturedLatestRuleKey, 'high-cap-dump-5m');
      assert.deepEqual(capturedMarkSeenArgs, [4, 'high-cap-dump-5m', 59]);
      assert.deepEqual(capturedFilters, {
        ruleKey: 'high-cap-dump-5m',
        limit: 50,
        afterId: 59,
        sort: 'asc',
      });
      assert.equal(payload.mode, 'unseen');
      assert.equal(payload.count, 0);
      assert.deepEqual(payload.cursor, {
        ruleKey: 'high-cap-dump-5m',
        lastSeenEventId: 59,
        lastAckedEventId: null,
        updatedAt: '2026-04-07T08:09:24.867Z',
      });
    } finally {
      alertDeliveryCursor.getCursor = originalGetCursor;
      tokenAlertEvent.getLatestEventId = originalGetLatestEventId;
      alertDeliveryCursor.markSeen = originalMarkSeen;
      tokenAlertEvent.listRecentEvents = originalListRecentEvents;
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
        ruleKey: 'high-cap-dump-5m',
        lastSeenEventId: 31,
      });

      assert.deepEqual(capturedPayload, {
        userId: 9,
        ruleKey: 'high-cap-dump-5m',
        lastSeenEventId: 31,
        lastAckedEventId: undefined,
      });
      assert.deepEqual(cursor, {
        ruleKey: 'high-cap-dump-5m',
        lastSeenEventId: 31,
        lastAckedEventId: null,
        updatedAt: '2026-04-05T18:20:00.000Z',
      });
    } finally {
      alertDeliveryCursor.upsertCursor = originalUpsertCursor;
    }
  });
});
