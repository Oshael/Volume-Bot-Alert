const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userUiPref = require('../src/models/user-ui-pref');

describe('user-ui-pref', () => {
  it('defaults enabled trade terminals for legacy prefs', () => {
    const prefs = userUiPref.normalizePrefs({});
    assert.deepEqual(prefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre']);
    assert.equal(prefs.manualFolderDeleteWarningDismissed, false);
    assert.equal(prefs.expandedSparklineGranularityMinutes, 5);
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

  it('rejects invalid expanded chart granularity preferences', () => {
    const validation = userUiPref.validatePatch({
      expandedSparklineGranularityMinutes: 10,
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('expandedSparklineGranularityMinutes must be one of 1, 5, 15, 30, 60, 240, 1440'));
  });

  it('rejects empty trade terminal selection', () => {
    const validation = userUiPref.validatePatch({
      enabledTradeTerminals: [],
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('enabledTradeTerminals must contain at least one terminal'));
  });
});
