const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userConfig = require('../src/models/user-config');
const userAlertProfileCache = require('../src/services/user-alert-profile-cache');

describe('user alert profile cache', () => {
  it('normalizes effective alert preferences from user config defaults and legacy surge fallbacks', () => {
    const profile = userAlertProfileCache.buildNormalizedAlertProfile(9, {
      threshold: 80,
      'mcap-threshold': 65,
      'min-vol': 15000,
      'min-mcap': 40000,
      'max-mcap': 900000,
      'hvnc-min-vol': 450000,
      'old-alert-1h-threshold': 32,
      'old-alert-6h-threshold': 88,
      'meteora-alert-1h-threshold': 75,
      'alert-vol-enabled': 'on',
      'alert-mcap-enabled': 'off',
      'alert-hvnc-enabled': 'on',
      'alert-old-surge-1h-enabled': 'off',
      'alert-old-surge-6h-enabled': 'on',
      'alert-meteora-surge-enabled': 'off',
    });

    assert.equal(profile.userId, 9);
    assert.deepEqual(profile.ruleEnabled, {
      monitoredVol: true,
      monitoredMcap: false,
      hvnc: true,
      recentSurge1h: false,
      recentSurge6h: true,
      oldWeekSurge1h: false,
      oldWeekSurge6h: true,
      meteoraSurge: false,
    });
    assert.equal(profile.thresholdPct, 80);
    assert.equal(profile.mcapThresholdPct, 65);
    assert.equal(profile.minVol, 15000);
    assert.equal(profile.minMcap, 40000);
    assert.equal(profile.maxMcap, 900000);
    assert.equal(profile.hvncMinVol, 450000);
    assert.equal(profile.recentSurge1hThresholdPct, 32);
    assert.equal(profile.recentSurge6hThresholdPct, 88);
    assert.equal(profile.oldWeekSurge1hThresholdPct, 32);
    assert.equal(profile.oldWeekSurge6hThresholdPct, 88);
    assert.equal(profile.meteoraAlert1hThreshold, 75);
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
          'min-vol': 8000,
          'min-mcap': 30000,
          'max-mcap': 0,
          'hvnc-min-vol': 300000,
          'old-alert-1h-threshold': 50,
          'old-alert-6h-threshold': 150,
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

      const firstProfiles = await userAlertProfileCache.listActiveProfiles({ nowMs: baseNowMs + 10_000 });
      assert.equal(firstProfiles.length, 1);
      assert.equal(firstProfiles[0].userId, 5);
      assert.equal(getAllCalls, 1);

      const secondProfiles = await userAlertProfileCache.listActiveProfiles({ nowMs: baseNowMs + 15_000 });
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

      const hiddenProfiles = await userAlertProfileCache.listActiveProfiles({ nowMs: baseNowMs + 61_000 });
      assert.equal(hiddenProfiles.length, 1);
      assert.equal(hiddenProfiles[0].presenceMode, 'hidden');
      assert.equal(hiddenProfiles[0].hiddenSessionKey, `hidden:${baseNowMs + 60_000}`);

      userAlertProfileCache.upsertLivePresence(5, 'socket-1', {
        workspace: 'live',
        mode: 'hidden',
        hiddenGraceMs: 20 * 60 * 1000,
      }, { nowMs: baseNowMs + 75_000 });

      const hiddenHeartbeatProfiles = await userAlertProfileCache.listActiveProfiles({ nowMs: baseNowMs + 76_000 });
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
        'min-vol': 8000,
        'min-mcap': 30000,
        'max-mcap': 0,
        'hvnc-min-vol': 300000,
        'old-alert-1h-threshold': 50,
        'old-alert-6h-threshold': 150,
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
      await userAlertProfileCache.listActiveProfiles();
      assert.equal(userAlertProfileCache.getStatus().cachedProfiles >= 1, true);

      userAlertProfileCache.clearLivePresence('socket-a');
      assert.equal(userAlertProfileCache.getStatus().cachedProfiles, 0);
      assert.equal(userAlertProfileCache.getStatus().trackedUsers, 0);
    } finally {
      userAlertProfileCache.clearLivePresence('socket-a');
      userConfig.getAllWithStoredKeys = originalGetAllWithStoredKeys;
    }
  });
});
