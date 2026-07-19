const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const contract = require('../src/services/robinhood-standard-alert-contract');

describe('Robinhood standard alert contract', () => {
  it('keeps FDV distinct from Solana MCAP and defines supported rule kinds', () => {
    assert.equal(contract.CHAIN, 'robinhood');
    assert.equal(contract.VALUATION_TYPE, 'fdv');
    assert.equal(contract.MONITORED_FDV_RULE_KEY, 'monitored-fdv');
    assert.equal(contract.STANDARD_RULE_KEYS.includes('monitored-mcap'), false);
    assert.equal(contract.isRobinhoodStandardRule('monitored-fdv', 'monitored-fdv'), true);
    assert.equal(contract.isRobinhoodStandardRule('recent-surge-1h', 'old-surge'), true);
    assert.equal(contract.isRobinhoodStandardRule('monitored-fdv', 'monitored-mcap'), false);
  });
});
