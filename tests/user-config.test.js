const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
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

  it('defines only alert settings supported by each chain', () => {
    const defaults = userConfig.buildDefaultConfigs();

    assert.equal(defaults['solana-mcap-threshold'], 50);
    assert.equal(defaults['solana-alert-meteora-surge-enabled'], 'on');
    assert.equal(defaults['robinhood-fdv-threshold'], 50);
    assert.equal(defaults['robinhood-alert-fdv-enabled'], 'off');
    assert.equal(userConfig.CONFIG_SCHEMA['robinhood-mcap-threshold'], undefined);
    assert.equal(userConfig.CONFIG_SCHEMA['robinhood-alert-meteora-surge-enabled'], undefined);
    assert.equal(userConfig.getChainAlertConfigKey('solana', 'fdv-threshold'), null);
  });

  it('copies legacy values into missing chain scopes without overwriting explicit values', () => {
    const configs = userConfig.buildDefaultConfigs();
    configs.threshold = 85;
    configs['alert-hvnc-enabled'] = 'off';
    configs['solana-threshold'] = 72;
    const storedKeys = new Set(['threshold', 'alert-hvnc-enabled', 'solana-threshold']);

    userConfig.applyLegacyChainAlertConfigFallbacks(configs, storedKeys);

    assert.equal(configs['solana-threshold'], 72);
    assert.equal(configs['robinhood-threshold'], 85);
    assert.equal(configs['solana-alert-hvnc-enabled'], 'off');
    assert.equal(configs['robinhood-alert-hvnc-enabled'], 'off');
  });

  it('validates scoped alert settings through the existing whitelist', () => {
    const validation = userConfig.validateConfigs({
      'solana-threshold': 61,
      'robinhood-fdv-threshold': 74,
      'robinhood-alert-fdv-enabled': 'on',
    });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.errors, []);
    assert.equal(validation.configs['solana-threshold'], 61);
    assert.equal(validation.configs['robinhood-fdv-threshold'], 74);
  });

  it('loads config versions for a deduplicated user batch', async () => {
    const originalQuery = db.query;
    let params = null;
    db.query = async (_sql, values) => {
      params = values;
      return {
        rows: [{ user_id: 2, config_version: new Date('2026-07-22T12:00:00.000Z') }],
      };
    };

    try {
      const versions = await userConfig.getVersions([2, 1, 2, 'invalid']);
      assert.deepEqual(params, [[2, 1]]);
      assert.equal(versions.get(1), null);
      assert.equal(versions.get(2), '2026-07-22T12:00:00.000Z');
    } finally {
      db.query = originalQuery;
    }
  });
});
