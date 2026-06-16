const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userConfig = require('../src/models/user-config');

describe('user config', () => {
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
