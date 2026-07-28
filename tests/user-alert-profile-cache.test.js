const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userConfig = require('../src/models/user-config');
const userUiPref = require('../src/models/user-ui-pref');
const userAlertProfileCache = require('../src/services/user-alert-profile-cache');

const originalGetAllUiPrefs = userUiPref.getAll;

beforeEach(() => {
  userUiPref.getAll = async () => ({
    chainFilters: { enabledChains: ['solana', 'robinhood'] },
  });
});

afterEach(() => {
  userUiPref.getAll = originalGetAllUiPrefs;
});

describe('user alert profile cache', () => {
  it('normalizes effective alert preferences from user config defaults and legacy surge fallbacks', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(9, {
      threshold: 80,
      'mcap-threshold': 65,
      'fdv-threshold': 70,
      'min-vol': 15000,
      'min-mcap': 40000,
      'max-mcap': 900000,
      'monitored-fdv-min': 50000,
      'monitored-fdv-max': 1500000,
      'hvnc-min-vol': 450000,
      'old-alert-1h-threshold': 32,
      'old-alert-6h-threshold': 88,
      'meteora-alert-1h-threshold': 75,
      'alert-vol-enabled': 'on',
      'alert-mcap-enabled': 'off',
      'alert-fdv-enabled': 'on',
      'alert-hvnc-enabled': 'on',
      'alert-old-surge-1h-enabled': 'off',
      'alert-old-surge-6h-enabled': 'on',
      'alert-meteora-surge-enabled': 'off',
    });

    assert.equal(profile.userId, 9);
    assert.deepEqual(profile.enabledChains, ['solana']);
    assert.deepEqual(profile.ruleEnabled, {
      monitoredVol: true,
      monitoredMcap: false,
      monitoredFdv: true,
      hvnc: true,
      recentSurge1h: false,
      recentSurge6h: true,
      oldWeekSurge1h: false,
      oldWeekSurge6h: true,
      meteoraSurge: false,
    });
    assert.equal(profile.thresholdPct, 80);
    assert.equal(profile.mcapThresholdPct, 65);
    assert.equal(profile.fdvThresholdPct, 70);
    assert.equal(profile.minVol, 15000);
    assert.equal(profile.minMcap, 40000);
    assert.equal(profile.maxMcap, 900000);
    assert.equal(profile.minFdv, 50000);
    assert.equal(profile.maxFdv, 1500000);
    assert.equal(profile.hvncMinVol, 450000);
    assert.equal(profile.recentSurge1hThresholdPct, 32);
    assert.equal(profile.recentSurge6hThresholdPct, 88);
    assert.equal(profile.oldWeekSurge1hThresholdPct, 32);
    assert.equal(profile.oldWeekSurge6hThresholdPct, 88);
    assert.equal(profile.meteoraAlert1hThreshold, 75);
  });

  it('keeps monitored-fdv disabled when the user has not opted in', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(12, {});
    assert.equal(profile.ruleEnabled.monitoredFdv, false);
  });

  it('normalizes independent Solana and Robinhood alert settings', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(13, {
      threshold: 50,
      'alert-vol-enabled': 'on',
      'solana-threshold': 65,
      'solana-alert-vol-enabled': 'on',
      'solana-alert-mcap-enabled': 'off',
      'solana-alert-gmgn-claim-pump-enabled': 'off',
      'robinhood-threshold': 92,
      'robinhood-fdv-threshold': 78,
      'robinhood-alert-vol-enabled': 'off',
      'robinhood-alert-fdv-enabled': 'on',
    });

    const solana = profile.alertConfigByChain.solana;
    const robinhood = profile.alertConfigByChain.robinhood;
    assert.equal(solana.thresholdPct, 65);
    assert.equal(solana.ruleEnabled.monitoredVol, true);
    assert.equal(solana.ruleEnabled.monitoredMcap, false);
    assert.equal(solana.ruleEnabled.monitoredFdv, false);
    assert.equal(solana.ruleEnabled.gmgnClaimPump, false);
    assert.equal(robinhood.thresholdPct, 92);
    assert.equal(robinhood.fdvThresholdPct, 78);
    assert.equal(robinhood.ruleEnabled.monitoredVol, false);
    assert.equal(robinhood.ruleEnabled.monitoredFdv, true);
    assert.equal(robinhood.ruleEnabled.monitoredMcap, false);
    assert.equal(robinhood.ruleEnabled.meteoraSurge, false);
  });

  it('normalizes enabled chains without duplicates or unsupported values', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(15, {}, {
      enabledChains: ['robinhood', 'solana', 'robinhood', 'base'],
    });

    assert.deepEqual(profile.enabledChains, ['robinhood', 'solana']);
  });

  it('keeps legacy values as fallback for both chain profiles', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(14, {
      threshold: 83,
      'alert-vol-enabled': 'off',
      'hvnc-min-vol': 510000,
    });

    for (const chain of ['solana', 'robinhood']) {
      assert.equal(profile.alertConfigByChain[chain].thresholdPct, 83);
      assert.equal(profile.alertConfigByChain[chain].ruleEnabled.monitoredVol, false);
      assert.equal(profile.alertConfigByChain[chain].hvncMinVol, 510000);
    }
  });

  it('prefers explicit recent and old-week surge config keys over legacy surge values', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(11, {
      'old-alert-1h-threshold': 50,
      'old-alert-6h-threshold': 150,
      'recent-surge-1h-threshold': 25,
      'old-week-surge-6h-threshold': 210,
      'alert-old-surge-1h-enabled': 'off',
      'alert-old-surge-6h-enabled': 'off',
      'alert-recent-surge-1h-enabled': 'on',
      'alert-old-week-surge-6h-enabled': 'on',
    }, {
      storedKeys: new Set([
        'old-alert-1h-threshold',
        'old-alert-6h-threshold',
        'recent-surge-1h-threshold',
        'old-week-surge-6h-threshold',
        'alert-old-surge-1h-enabled',
        'alert-old-surge-6h-enabled',
        'alert-recent-surge-1h-enabled',
        'alert-old-week-surge-6h-enabled',
      ]),
    });

    assert.equal(profile.recentSurge1hThresholdPct, 25);
    assert.equal(profile.recentSurge6hThresholdPct, 150);
    assert.equal(profile.oldWeekSurge1hThresholdPct, 50);
    assert.equal(profile.oldWeekSurge6hThresholdPct, 210);
    assert.equal(profile.ruleEnabled.recentSurge1h, true);
    assert.equal(profile.ruleEnabled.recentSurge6h, false);
    assert.equal(profile.ruleEnabled.oldWeekSurge1h, false);
    assert.equal(profile.ruleEnabled.oldWeekSurge6h, true);
  });

  it('treats foreground and hidden presence as active under the hybrid model', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    let getAllCalls = 0;
    userConfig.getAllWithStoredKeys = async () => {
      getAllCalls += 1;
      return {
        configs: {
          threshold: 50,
          'mcap-threshold': 50,
          'min-vol': 10000,
          'min-mcap': 30000,
          'max-mcap': 0,
          'hvnc-min-vol': 300000,
          'old-alert-1h-threshold': 50,
          'old-alert-6h-threshold': 100,
          'meteora-alert-1h-threshold': 50,
          'alert-vol-enabled': 'on',
          'alert-mcap-enabled': 'on',
          'alert-hvnc-enabled': 'on',
          'alert-old-surge-1h-enabled': 'on',
          'alert-old-surge-6h-enabled': 'on',
          'alert-meteora-surge-enabled': 'on',
        },
        storedKeys: new Set([
          'threshold',
          'mcap-threshold',
          'min-vol',
          'min-mcap',
          'max-mcap',
          'hvnc-min-vol',
          'old-alert-1h-threshold',
          'old-alert-6h-threshold',
          'meteora-alert-1h-threshold',
          'alert-vol-enabled',
          'alert-mcap-enabled',
          'alert-hvnc-enabled',
          'alert-old-surge-1h-enabled',
          'alert-old-surge-6h-enabled',
          'alert-meteora-surge-enabled',
        ]),
      };
    };

    const baseNowMs = Date.UTC(2026, 3, 16, 12, 0, 0);

    try {
      userAlertProfileCache.upsertLivePresence(5, 'socket-1', {
        workspace: 'live',
        mode: 'foreground',
      }, { nowMs: baseNowMs });

      assert.deepEqual(userAlertProfileCache.listActiveUserIds({ nowMs: baseNowMs + 10_000 }), [5]);

      const firstProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 10_000,
        sharedPresence: false,
      });
      assert.equal(firstProfiles.length, 1);
      assert.equal(firstProfiles[0].userId, 5);
      assert.equal(getAllCalls, 1);

      const secondProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 15_000,
        sharedPresence: false,
      });
      assert.equal(secondProfiles.length, 1);
      assert.equal(getAllCalls, 1);

      assert.deepEqual(
        userAlertProfileCache.listActiveUserIds({ nowMs: baseNowMs + userAlertProfileCache.FOREGROUND_TTL_MS + 1 }),
        []
      );

      userAlertProfileCache.upsertLivePresence(5, 'socket-1', {
        workspace: 'live',
        mode: 'hidden',
        hiddenGraceMs: 20 * 60 * 1000,
      }, { nowMs: baseNowMs + 60_000 });

      const hiddenProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 61_000,
        sharedPresence: false,
      });
      assert.equal(hiddenProfiles.length, 1);
      assert.equal(hiddenProfiles[0].presenceMode, 'hidden');
      assert.equal(hiddenProfiles[0].hiddenSessionKey, `hidden:${baseNowMs + 60_000}`);

      userAlertProfileCache.upsertLivePresence(5, 'socket-1', {
        workspace: 'live',
        mode: 'hidden',
        hiddenGraceMs: 20 * 60 * 1000,
      }, { nowMs: baseNowMs + 75_000 });

      const hiddenHeartbeatProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 76_000,
        sharedPresence: false,
      });
      assert.equal(hiddenHeartbeatProfiles.length, 1);
      assert.equal(hiddenHeartbeatProfiles[0].presenceMode, 'hidden');
      assert.equal(hiddenHeartbeatProfiles[0].hiddenSessionKey, `hidden:${baseNowMs + 60_000}`);

      assert.deepEqual(
        userAlertProfileCache.listActiveUserIds({ nowMs: baseNowMs + (10 * 60 * 1000) }),
        [5]
      );
      assert.deepEqual(
        userAlertProfileCache.listActiveUserIds({ nowMs: baseNowMs + (21 * 60 * 1000) }),
        [5]
      );
      assert.deepEqual(
        userAlertProfileCache.listActiveUserIds({ nowMs: baseNowMs + (22 * 60 * 1000) }),
        []
      );

      userAlertProfileCache.upsertLivePresence(5, 'socket-1', {
        workspace: 'live',
        mode: 'inactive',
      }, { nowMs: baseNowMs + 70_000 });

      assert.deepEqual(
        userAlertProfileCache.listActiveUserIds({ nowMs: baseNowMs + 70_001 }),
        []
      );
    } finally {
      userAlertProfileCache.clearLivePresence('socket-1');
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
    }
  });

  it('drops cached profiles when the last tracked socket disappears', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    userConfig.getAllWithStoredKeys = async () => ({
      configs: {
        threshold: 50,
        'mcap-threshold': 50,
        'min-vol': 10000,
        'min-mcap': 30000,
        'max-mcap': 0,
        'hvnc-min-vol': 300000,
        'old-alert-1h-threshold': 50,
        'old-alert-6h-threshold': 100,
        'meteora-alert-1h-threshold': 50,
        'alert-vol-enabled': 'on',
        'alert-mcap-enabled': 'on',
        'alert-hvnc-enabled': 'on',
        'alert-old-surge-1h-enabled': 'on',
        'alert-old-surge-6h-enabled': 'on',
        'alert-meteora-surge-enabled': 'on',
      },
      storedKeys: new Set([
        'threshold',
        'mcap-threshold',
        'min-vol',
        'min-mcap',
        'max-mcap',
        'hvnc-min-vol',
        'old-alert-1h-threshold',
        'old-alert-6h-threshold',
        'meteora-alert-1h-threshold',
        'alert-vol-enabled',
        'alert-mcap-enabled',
        'alert-hvnc-enabled',
        'alert-old-surge-1h-enabled',
        'alert-old-surge-6h-enabled',
        'alert-meteora-surge-enabled',
      ]),
    });

    try {
      userAlertProfileCache.upsertLivePresence(7, 'socket-a', {
        workspace: 'live',
        mode: 'foreground',
      });
      await userAlertProfileCache.listActiveProfiles({ sharedPresence: false });
      assert.equal(userAlertProfileCache.getStatus().cachedProfiles >= 1, true);

      userAlertProfileCache.clearLivePresence('socket-a');
      assert.equal(userAlertProfileCache.getStatus().cachedProfiles, 0);
      assert.equal(userAlertProfileCache.getStatus().trackedUsers, 0);
    } finally {
      userAlertProfileCache.clearLivePresence('socket-a');
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
    }
  });

  it('uses shared presence for worker active profiles without querying session fallback', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    let getAllCalls = 0;
    let sessionQueries = 0;
    const db = {
      async query() {
        sessionQueries += 1;
        return { rows: [{ user_id: 21 }] };
      },
    };
    userConfig.getAllWithStoredKeys = async () => {
      getAllCalls += 1;
      return { configs: {}, storedKeys: new Set() };
    };

    try {
      const profiles = await userAlertProfileCache.listActiveProfiles({
        db,
        sharedPresence: true,
        sharedPresenceRows: [],
      });

      assert.deepEqual(profiles, []);
      assert.equal(getAllCalls, 0);
      assert.equal(sessionQueries, 0);
    } finally {
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
      userAlertProfileCache.invalidateUserProfile(21);
    }
  });

  it('aggregates shared foreground and hidden presences into alert profiles', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    let getAllCalls = 0;
    const baseNowMs = Date.UTC(2026, 6, 8, 12, 0, 0);
    userConfig.getAllWithStoredKeys = async (userId) => {
      getAllCalls += 1;
      return {
        configs: {
          threshold: userId === 31 ? 85 : 45,
          'alert-vol-enabled': 'on',
        },
        storedKeys: new Set(['threshold', 'alert-vol-enabled']),
      };
    };

    try {
      const profiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs,
        sharedPresence: true,
        sharedPresenceRows: [
          {
            userId: 31,
            mode: 'hidden',
            hiddenStartedAt: new Date(baseNowMs - 30_000).toISOString(),
            activeUntilAt: new Date(baseNowMs + 60_000).toISOString(),
          },
          {
            userId: 32,
            mode: 'foreground',
            foregroundSeenAt: new Date(baseNowMs).toISOString(),
            activeUntilAt: new Date(baseNowMs + 45_000).toISOString(),
          },
        ],
      });

      assert.deepEqual(profiles.map((profile) => profile.userId), [31, 32]);
      assert.equal(profiles[0].presenceMode, 'hidden');
      assert.equal(profiles[0].hiddenSessionKey, `hidden:${baseNowMs - 30_000}`);
      assert.equal(profiles[0].thresholdPct, 85);
      assert.equal(profiles[1].presenceMode, 'foreground');
      assert.equal(profiles[1].hiddenSessionKey, null);
      assert.equal(getAllCalls, 2);
    } finally {
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
      userAlertProfileCache.invalidateUserProfile(31);
      userAlertProfileCache.invalidateUserProfile(32);
    }
  });

  it('evicts a shared profile after the user is observed inactive', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    const baseNowMs = Date.UTC(2026, 6, 8, 13, 0, 0);
    let getAllCalls = 0;
    userConfig.getAllWithStoredKeys = async () => {
      getAllCalls += 1;
      return {
        configs: { threshold: 60 + getAllCalls },
        storedKeys: new Set(['threshold']),
      };
    };

    try {
      const firstProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs,
        sharedPresence: true,
        sharedPresenceRows: [{
          userId: 41,
          mode: 'foreground',
          activeUntilAt: new Date(baseNowMs + 1_000).toISOString(),
        }],
      });

      const secondProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 500,
        sharedPresence: true,
        sharedPresenceRows: [{
          userId: 41,
          mode: 'foreground',
          activeUntilAt: new Date(baseNowMs + 1_000).toISOString(),
        }],
      });

      const thirdProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 1_500,
        sharedPresence: true,
        sharedPresenceRows: [],
      });

      const fourthProfiles = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 2_000,
        sharedPresence: true,
        sharedPresenceRows: [{
          userId: 41,
          mode: 'foreground',
          activeUntilAt: new Date(baseNowMs + 10_000).toISOString(),
        }],
      });

      assert.equal(firstProfiles[0].thresholdPct, 61);
      assert.equal(secondProfiles[0].thresholdPct, 61);
      assert.deepEqual(thirdProfiles, []);
      assert.equal(fourthProfiles[0].thresholdPct, 62);
      assert.equal(getAllCalls, 2);
    } finally {
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
      userAlertProfileCache.invalidateUserProfile(41);
    }
  });

  it('keeps shared config profiles until an explicit invalidation', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    const baseNowMs = Date.UTC(2026, 6, 22, 12, 0, 0);
    let getAllCalls = 0;
    userConfig.getAllWithStoredKeys = async () => {
      getAllCalls += 1;
      return {
        configs: { threshold: 50 + getAllCalls },
        storedKeys: new Set(['threshold']),
      };
    };
    const activePresence = (nowMs) => [{
      userId: 42,
      sessionKey: 'login-session-42',
      mode: 'foreground',
      activeUntilAt: new Date(nowMs + 60_000).toISOString(),
    }];

    try {
      const first = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs,
        sharedPresence: true,
        sharedPresenceRows: activePresence(baseNowMs),
      });
      const cached = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 60_001,
        sharedPresence: true,
        sharedPresenceRows: activePresence(baseNowMs + 60_001),
      });

      assert.equal(getAllCalls, 1);
      assert.equal(cached[0].thresholdPct, first[0].thresholdPct);
      assert.equal(cached[0].loadedAt, first[0].loadedAt);

      userAlertProfileCache.invalidateUserProfile(42, {
        configVersion: '2026-07-22T12:01:30.000Z',
      });
      const refreshed = await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 90_000,
        sharedPresence: true,
        sharedPresenceRows: activePresence(baseNowMs + 90_000),
      });

      assert.equal(getAllCalls, 2);
      assert.notEqual(first[0].thresholdPct, refreshed[0].thresholdPct);
      assert.equal(first[0].loadedAt, new Date(baseNowMs).toISOString());
      assert.equal(refreshed[0].loadedAt, first[0].loadedAt);
      assert.equal(refreshed[0].alertSessionKey, 'login-session-42');
    } finally {
      await userAlertProfileCache.listActiveProfiles({
        nowMs: baseNowMs + 60_000,
        sharedPresence: true,
        sharedPresenceRows: [],
      });
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
      userAlertProfileCache.invalidateUserProfile(42);
    }
  });

  it('persists shared socket presence writes with authenticated session context', async () => {
    const calls = [];
    const sharedPresenceModel = {
      async upsert(payload, options) {
        calls.push({ type: 'upsert', payload, options });
        return { id: 1, ...payload };
      },
      async disconnect(payload, options) {
        calls.push({ type: 'disconnect', payload, options });
        return { id: 1, ...payload };
      },
    };

    await userAlertProfileCache.upsertSharedLivePresence(51, 'socket-51', {
      workspace: 'live',
      mode: 'hidden',
      hiddenGraceMs: 120_000,
    }, {
      nowMs: 1000,
      sessionKey: 'session-51',
      webInstanceId: 'web-1',
      sharedPresenceModel,
    });
    await userAlertProfileCache.clearSharedLivePresence('socket-51', {
      nowMs: 2000,
      webInstanceId: 'web-1',
      sharedPresenceModel,
    });

    assert.deepEqual(calls[0].payload, {
      userId: 51,
      sessionKey: 'session-51',
      socketId: 'socket-51',
      webInstanceId: 'web-1',
      mode: 'hidden',
      hiddenGraceMs: 120_000,
    });
    assert.equal(calls[0].options.nowMs, 1000);
    assert.deepEqual(calls[1].payload, {
      socketId: 'socket-51',
      webInstanceId: 'web-1',
    });
  });

  it('ignores stale config invalidations for a newer cached profile', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    userConfig.getAllWithStoredKeys = async () => ({
      configs: { threshold: 77 },
      storedKeys: new Set(['threshold']),
      configVersion: '2026-07-09T14:00:00.000Z',
    });

    try {
      await userAlertProfileCache.refreshUserProfile(61);
      const staleResult = userAlertProfileCache.invalidateUserProfile(61, {
        configVersion: '2026-07-09T13:59:59.000Z',
      });
      const cachedAfterStale = userAlertProfileCache.__private.getCachedUserProfile(61);
      const freshResult = userAlertProfileCache.invalidateUserProfile(61, {
        configVersion: '2026-07-09T14:00:01.000Z',
      });
      const cachedAfterFresh = userAlertProfileCache.__private.getCachedUserProfile(61);

      assert.equal(staleResult, false);
      assert.equal(cachedAfterStale.thresholdPct, 77);
      assert.equal(freshResult, true);
      assert.equal(cachedAfterFresh, null);
    } finally {
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
      userAlertProfileCache.invalidateUserProfile(61);
    }
  });

  it('force-invalidates a cached profile when UI preferences change', async () => {
    const originalGetAllWithStoredKeys = userConfig.getAllWithStoredKeys;
    userConfig.getAllWithStoredKeys = async () => ({
      configs: { threshold: 77 },
      storedKeys: new Set(['threshold']),
      configVersion: '2026-07-09T14:00:00.000Z',
    });

    try {
      const profile = await userAlertProfileCache.refreshUserProfile(62);
      assert.deepEqual(profile.enabledChains, ['solana', 'robinhood']);
      assert.equal(userAlertProfileCache.invalidateUserProfile(62, {
        configVersion: profile.configVersion,
        force: true,
      }), true);
      assert.equal(userAlertProfileCache.__private.getCachedUserProfile(62), null);
    } finally {
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
      userAlertProfileCache.invalidateUserProfile(62);
    }
  });
});
