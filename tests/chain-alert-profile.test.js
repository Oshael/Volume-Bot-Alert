const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectAlertProfileForChain,
  selectEnabledAlertProfilesForChain,
} = require('../src/services/chain-alert-profile');

describe('chain alert profile', () => {
  it('selects scoped settings while preserving alert-session metadata', () => {
    const profile = {
      userId: 7,
      configVersion: '2026-07-28T12:00:00.000Z',
      alertSessionKey: 'session-a',
      loadedAt: '2026-07-28T11:00:00.000Z',
      presenceMode: 'foreground',
      ruleEnabled: { monitoredVol: false },
      thresholdPct: 500,
      alertConfigByChain: {
        solana: {
          chain: 'solana',
          ruleEnabled: { monitoredVol: true },
          thresholdPct: 65,
        },
      },
    };

    const selected = selectAlertProfileForChain(profile, 'solana');

    assert.notEqual(selected, profile);
    assert.equal(selected.userId, 7);
    assert.equal(selected.configVersion, profile.configVersion);
    assert.equal(selected.alertSessionKey, profile.alertSessionKey);
    assert.equal(selected.loadedAt, profile.loadedAt);
    assert.equal(selected.presenceMode, 'foreground');
    assert.equal(selected.chain, 'solana');
    assert.equal(selected.thresholdPct, 65);
    assert.deepEqual(selected.ruleEnabled, { monitoredVol: true });
    assert.notEqual(selected.ruleEnabled, profile.alertConfigByChain.solana.ruleEnabled);
  });

  it('returns the legacy profile when the chain scope is unavailable', () => {
    const profile = { userId: 9, ruleEnabled: { monitoredVol: true } };

    assert.equal(selectAlertProfileForChain(profile, 'solana'), profile);
    assert.equal(selectAlertProfileForChain(profile, 'unsupported'), profile);
    assert.equal(selectAlertProfileForChain(null, 'solana'), null);
  });

  it('filters disabled chains before selecting scoped settings', () => {
    const profiles = [
      {
        userId: 1,
        enabledChains: ['solana'],
        alertConfigByChain: { solana: { thresholdPct: 61 } },
      },
      {
        userId: 2,
        enabledChains: ['robinhood'],
        alertConfigByChain: { robinhood: { thresholdPct: 92 } },
      },
    ];

    assert.deepEqual(
      selectEnabledAlertProfilesForChain(profiles, 'robinhood')
        .map((profile) => [profile.userId, profile.thresholdPct]),
      [[2, 92]],
    );
    assert.deepEqual(
      selectEnabledAlertProfilesForChain([{ userId: 3, enabledChains: 'robinhood' }], 'robinhood'),
      [],
    );
  });
});
