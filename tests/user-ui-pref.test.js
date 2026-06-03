const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userUiPref = require('../src/models/user-ui-pref');

describe('user-ui-pref', () => {
  it('defaults enabled trade terminals for legacy prefs', () => {
    const prefs = userUiPref.normalizePrefs({});
    assert.deepEqual(prefs.enabledTradeTerminals, ['axiom', 'photon', 'bullx', 'gmgn', 'padre']);
  });

  it('defaults new live layouts with alerts spanning two thirds', () => {
    const prefs = userUiPref.normalizePrefs({});
    assert.deepEqual(prefs.livePanelLayout, {
      order: ['monitored', 'pumpfun', 'alerts'],
      spans: {
        monitored: 1,
        pumpfun: 1,
        alerts: 2,
      },
    });
  });

  it('accepts a filtered trade terminal selection', () => {
    const validation = userUiPref.validatePatch({
      enabledTradeTerminals: ['bullx', 'gmgn'],
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.prefs.enabledTradeTerminals, ['bullx', 'gmgn']);
  });

  it('rejects empty trade terminal selection', () => {
    const validation = userUiPref.validatePatch({
      enabledTradeTerminals: [],
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.includes('enabledTradeTerminals must contain at least one terminal'));
  });
});
