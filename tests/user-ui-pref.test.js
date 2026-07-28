const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userUiPref = require('../src/models/user-ui-pref');

describe('user-ui-pref', () => {
  it('defaults enabled trade terminals for legacy prefs', () => {
    const prefs = userUiPref.normalizePrefs({});
    assert.deepEqual(prefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo']);
    assert.equal(prefs.tradeTerminalCatalogVersion, 2);
    assert.equal(prefs.manualFolderDeleteWarningDismissed, false);
    assert.equal(prefs.expandedSparklineGranularityMinutes, 5);
    assert.equal(prefs.expandedSparklineTimeZone, 'browser');
    assert.deepEqual(prefs.chainFilters, {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    });
    assert.deepEqual(prefs.sparklineRange, {
      monitoredDays: 14,
      recentDays: 14,
      oldWeekDays: 14,
      monitoredPreset: '14d',
      recentPreset: '14d',
      oldWeekPreset: '14d',
      tokenDaysByAddress: {},
      tokenPresetByAddress: {},
    });
  });

  it('defaults new live layouts with monitored spanning two thirds', () => {
    const prefs = userUiPref.normalizePrefs({});
    assert.deepEqual(prefs.livePanelLayout, {
      order: ['monitored', 'pumpfun', 'alerts'],
      spans: {
        monitored: 2,
        pumpfun: 1,
        alerts: 1,
      },
      heights: {
        monitored: 620,
        alerts: 620,
      },
    });
  });

  it('preserves legacy live layout choices while defaulting missing heights', () => {
    const prefs = userUiPref.normalizePrefs({
      livePanelLayout: {
        order: ['alerts', 'monitored', 'pumpfun'],
        spans: {
          monitored: 3,
          pumpfun: 1,
          alerts: 2,
        },
      },
    });

    assert.deepEqual(prefs.livePanelLayout, {
      order: ['alerts', 'monitored', 'pumpfun'],
      spans: {
        monitored: 3,
        pumpfun: 1,
        alerts: 2,
      },
      heights: {
        monitored: 620,
        alerts: 620,
      },
    });
  });

  it('validates persisted live panel heights', () => {
    const validation = userUiPref.validatePatch({
      livePanelLayout: {
        order: ['monitored', 'pumpfun', 'alerts'],
        spans: {
          monitored: 2,
          pumpfun: 1,
          alerts: 1,
        },
        heights: {
          monitored: 840.4,
          alerts: 1320,
        },
      },
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.livePanelLayout.heights, {
      monitored: 840,
      alerts: 1320,
    });
  });

  it('rejects unsafe live panel heights', () => {
    const validation = userUiPref.validatePatch({
      livePanelLayout: {
        order: ['monitored', 'pumpfun', 'alerts'],
        spans: {
          monitored: 2,
          pumpfun: 1,
          alerts: 1,
        },
        heights: {
          monitored: 0,
          alerts: 620,
        },
      },
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('livePanelLayout.heights.monitored must be between 1 and 100000'));
  });

  it('accepts a filtered trade terminal selection', () => {
    const validation = userUiPref.validatePatch({
      enabledTradeTerminals: ['bullx', 'gmgn'],
      manualFolderDeleteWarningDismissed: true,
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.enabledTradeTerminals, ['bullx', 'gmgn']);
    assert.equal(validation.prefs.manualFolderDeleteWarningDismissed, true);
  });

  it('enables FOMO once for legacy terminal preferences while preserving later opt-outs', () => {
    const legacyPrefs = userUiPref.normalizePrefs({
      enabledTradeTerminals: ['axiom', 'photon', 'bullx', 'gmgn', 'padre'],
    });
    assert.deepEqual(legacyPrefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo']);

    const currentPrefs = userUiPref.normalizePrefs({
      enabledTradeTerminals: ['axiom', 'photon', 'bullx', 'gmgn', 'padre'],
      tradeTerminalCatalogVersion: 2,
    });
    assert.deepEqual(currentPrefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre']);
  });

  it('accepts valid expanded chart granularity preferences', () => {
    const validation = userUiPref.validatePatch({
      expandedSparklineGranularityMinutes: 1,
    });

    assert.equal(validation.valid, true);
    assert.equal(validation.prefs.expandedSparklineGranularityMinutes, 1);
  });

  it('accepts supported expanded chart time zones', () => {
    const validation = userUiPref.validatePatch({
      expandedSparklineTimeZone: 'America/Fortaleza',
    });

    assert.equal(validation.valid, true);
    assert.equal(validation.prefs.expandedSparklineTimeZone, 'America/Fortaleza');
  });

  it('accepts scoped and individual token sparkline range preferences', () => {
    const validation = userUiPref.validatePatch({
      sparklineRange: {
        monitoredDays: 14,
        recentDays: 7,
        oldWeekDays: 1,
        monitoredPreset: 'all',
        recentPreset: '7d',
        oldWeekPreset: '12h',
        tokenDaysByAddress: {
          TokenRange111111111111111111111111111111111: 2,
        },
        tokenPresetByAddress: {
          TokenPreset11111111111111111111111111111111: 'all',
        },
      },
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.sparklineRange, {
      monitoredDays: 14,
      recentDays: 7,
      oldWeekDays: 1,
      monitoredPreset: 'all',
      recentPreset: '7d',
      oldWeekPreset: '12h',
      tokenDaysByAddress: {
        TokenRange111111111111111111111111111111111: 2,
      },
      tokenPresetByAddress: {
        TokenPreset11111111111111111111111111111111: 'all',
      },
    });
  });

  it('migrates the legacy global range into each independent scope', () => {
    const prefs = userUiPref.normalizePrefs({
      sparklineRange: {
        global: true,
        globalDays: 7,
        monitoredDays: 2,
        recentDays: 3,
        oldWeekDays: 10,
        tokenDaysByAddress: {},
      },
    });

    assert.deepEqual(prefs.sparklineRange, {
      monitoredDays: 7,
      recentDays: 7,
      oldWeekDays: 7,
      monitoredPreset: '7d',
      recentPreset: '7d',
      oldWeekPreset: '7d',
      tokenDaysByAddress: {},
      tokenPresetByAddress: {},
    });
  });

  it('rejects unsupported sparkline range presets', () => {
    const validation = userUiPref.validatePatch({
      sparklineRange: {
        monitoredPreset: '2d',
      },
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('sparklineRange.monitoredPreset must be a supported range preset'));
  });

  it('rejects invalid individual token sparkline range preferences', () => {
    const validation = userUiPref.validatePatch({
      sparklineRange: {
        tokenDaysByAddress: {
          TokenRange111111111111111111111111111111111: 30,
        },
      },
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.includes('tokenDaysByAddress.TokenRange111111111111111111111111111111111 must be between 1 and 14')));
  });

  it('rejects invalid expanded chart granularity preferences', () => {
    const validation = userUiPref.validatePatch({
      expandedSparklineGranularityMinutes: 10,
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('expandedSparklineGranularityMinutes must be one of 1, 5, 15, 30, 60, 240, 1440'));
  });

  it('rejects unsupported expanded chart time zones', () => {
    const validation = userUiPref.validatePatch({
      expandedSparklineTimeZone: 'Mars/Olympus_Mons',
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.includes('expandedSparklineTimeZone must be one of')));
  });

  it('rejects empty trade terminal selection', () => {
    const validation = userUiPref.validatePatch({
      enabledTradeTerminals: [],
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('enabledTradeTerminals must contain at least one terminal'));
  });

  it('accepts complete chain filters constrained by the master selection', () => {
    const chainFilters = {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    };
    const validation = userUiPref.validatePatch({ chainFilters });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.chainFilters, chainFilters);
  });

  it('normalizes stale Radar and alert-feed selections to enabled chains', () => {
    const prefs = userUiPref.normalizePrefs({
      chainFilters: {
        enabledChains: ['solana', 'robinhood'],
        radarChains: ['solana'],
        alertFeedChains: ['robinhood'],
        browserNotificationChains: ['robinhood'],
      },
    });

    assert.deepEqual(prefs.chainFilters, {
      enabledChains: ['solana', 'robinhood'],
      radarChains: ['solana', 'robinhood'],
      alertFeedChains: ['solana', 'robinhood'],
      browserNotificationChains: ['robinhood'],
    });
  });

  it('accepts stale legacy surface selections but persists the master scope', () => {
    const validation = userUiPref.validatePatch({
      chainFilters: {
        enabledChains: ['solana'],
        radarChains: ['robinhood'],
        alertFeedChains: ['robinhood'],
        browserNotificationChains: ['solana'],
      },
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.chainFilters, {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    });
  });

  it('rejects empty or unavailable chain filters', () => {
    const empty = userUiPref.validatePatch({
      chainFilters: {
        enabledChains: [],
        radarChains: ['solana'],
        alertFeedChains: ['solana'],
        browserNotificationChains: ['solana'],
      },
    });
    const unavailable = userUiPref.validatePatch({
      chainFilters: {
        enabledChains: ['solana', 'base'],
        radarChains: ['solana'],
        alertFeedChains: ['solana'],
        browserNotificationChains: ['solana'],
      },
    });

    assert.equal(empty.valid, false);
    assert.equal(unavailable.valid, false);
    assert.ok(unavailable.errors.some((error) => error.includes('unavailable chain: base')));
  });
});
