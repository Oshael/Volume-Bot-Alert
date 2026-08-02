const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const catalog = require('../src/models/robinhood-catalog');
const {
  classifyRobinhoodLaunchpad,
  normalizeLaunchpadId,
} = require('../src/services/robinhood-launchpad-attribution');

const TOKEN = `0x${'1'.repeat(40)}`;

describe('Robinhood launchpad attribution', () => {
  it('classifies stable metadata and creator-factory evidence', () => {
    const scenarios = [{
      input: { metadataSource: 'pons-onchain' },
      id: 'pons', evidence: 'token-metadata',
    }, {
      input: { bankrDopplerVerified: true },
      id: 'bankr-doppler', evidence: 'bankr-registry',
    }, {
      input: { metadataSource: 'robinhood-stock-api' },
      id: 'robinhood-stock', evidence: 'stock-registry',
    }, {
      input: { creatorAddress: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' },
      id: 'pons', evidence: 'creator-factory',
    }, {
      input: { creatorAddress: '0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf' },
      id: 'launchhood', evidence: 'creator-factory',
    }, {
      input: { creatorAddress: '0x5C1C1dE6950F9DCfE31BE99D457Fa7732B2Ce93B' },
      id: 'robinpad', evidence: 'creator-factory',
    }, {
      input: {}, id: 'robinhood', evidence: 'chain-fallback',
    }];

    for (const scenario of scenarios) {
      const actual = classifyRobinhoodLaunchpad(scenario.input);
      assert.equal(actual.id, scenario.id);
      assert.equal(actual.evidence, scenario.evidence);
    }
  });

  it('prefers a known creator factory over generic token metadata', () => {
    const actual = classifyRobinhoodLaunchpad({
      creatorAddress: '0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf',
      metadataSource: 'bankr-ipfs',
    });

    assert.equal(actual.id, 'launchhood');
    assert.equal(normalizeLaunchpadId('unknown'), null);
    assert.equal(classifyRobinhoodLaunchpad({ metadataSource: 'bankr-ipfs' }).id, 'robinhood');
  });

  it('persists attribution without downgrading a known launchpad to the fallback', async () => {
    const calls = [];
    await catalog.recordLaunchpadAttribution({ address: TOKEN, launchpadId: 'robinhood' }, {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    });

    assert.match(calls[0].sql, /WHEN \$2 = 'robinhood' AND launchpad_id IS NOT NULL/);
    assert.match(calls[0].sql, /launchpad_checked_at = NOW\(\)/);
    assert.deepEqual(calls[0].params, [TOKEN, 'robinhood']);
    await assert.rejects(
      catalog.recordLaunchpadAttribution({ address: TOKEN, launchpadId: 'invalid' }),
      /unsupported/
    );
  });
});
