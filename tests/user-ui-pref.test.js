const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userUiPref = require('../src/models/user-ui-pref');

describe('user-ui-pref', () => {
  it('defaults enabled trade terminals for legacy prefs', () => {
    const prefs = userUiPref.normalizePrefs({});
    assert.deepEqual(prefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre']);
    assert.equal(prefs.manualFolderDeleteWarningDismissed, false);
    assert.equal(prefs.expandedSparklineGranularityMinutes, 5);
    assert.equal(prefs.expandedSparklineTimeZone, 'browser');
    assert.deepEqual(prefs.chainFilters, {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
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

  it('accepts individual token sparkline range preferences', () => {
    const validation = userUiPref.validatePatch({
      sparklineRange: {
        global: true,
        globalDays: 14,
        monitoredDays: 14,
        recentDays: 7,
        oldWeekDays: 14,
        tokenDaysByAddress: {
          TokenRange111111111111111111111111111111111: 2,
        },
      },
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.sparklineRange.tokenDaysByAddress, {
      TokenRange111111111111111111111111111111111: 2,
    });
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
