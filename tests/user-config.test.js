const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userConfig = require('../src/models/user-config');

describe('user config', () => {
  it('defines opt-in Robinhood FDV alert preferences', () => {
    const defaults = userConfig.buildDefaultConfigs();
    assert.equal(defaults['alert-fdv-enabled'], 'off');
    assert.equal(defaults['fdv-threshold'], 50);
    assert.equal(defaults['monitored-fdv-min'], 30000);
    assert.equal(defaults['monitored-fdv-max'], 0);
    assert.equal(defaults['monitored-view-mcap-max'], 0);
    assert.equal(defaults['monitored-view-fdv-max'], 0);

    const validation = userConfig.validateConfigs({
      'alert-fdv-enabled': 'on', 'fdv-threshold': 75,
      'monitored-fdv-min': 50000, 'monitored-fdv-max': 2000000,
      'monitored-view-mcap-max': 900000,
      'monitored-view-fdv-max': 1200000,
    });
    assert.equal(validation.valid, true);
    assert.equal(validation.configs['fdv-threshold'], 75);
    assert.equal(validation.configs['monitored-view-mcap-max'], 900000);
    assert.equal(validation.configs['monitored-view-fdv-max'], 1200000);
  });

  it('supports separate GMGN claim alert origin toggles', () => {
    const defaults = userConfig.buildDefaultConfigs();
    assert.equal(defaults['alert-gmgn-claim-pump-enabled'], 'on');
    assert.equal(defaults['alert-gmgn-claim-bags-enabled'], 'on');

    const validation = userConfig.validateConfigs({
      'alert-gmgn-claim-pump-enabled': 'off',
      'alert-gmgn-claim-bags-enabled': 'on',
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.errors, []);
    assert.equal(validation.configs['alert-gmgn-claim-pump-enabled'], 'off');
    assert.equal(validation.configs['alert-gmgn-claim-bags-enabled'], 'on');
  });

  it('falls back separate GMGN claim toggles to the legacy claim toggle', () => {
    const configs = userConfig.buildDefaultConfigs();
    configs['alert-gmgn-claim-signal-enabled'] = 'off';

    userConfig.applyLegacyGmgnClaimConfigFallbacks(configs, new Set(['alert-gmgn-claim-signal-enabled']));

    assert.equal(configs['alert-gmgn-claim-pump-enabled'], 'off');
    assert.equal(configs['alert-gmgn-claim-bags-enabled'], 'off');
  });
});
