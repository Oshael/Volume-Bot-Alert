const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  getAvailableTokenChains,
  isRobinhoodUserVisible,
  isTokenChainUserVisible,
} = require('../src/utils/token-chain-availability');

describe('token chain availability', () => {
  it('keeps Robinhood hidden unless user visibility is explicitly enabled', () => {
    assert.deepEqual(getAvailableTokenChains(), ['solana']);
    assert.deepEqual(
      getAvailableTokenChains({ robinhoodConfigured: true, robinhoodAlertsRequested: true }),
      ['solana'],
    );
  });

  it('exposes Robinhood independently from ingestion and alert activation', () => {
    assert.deepEqual(
      getAvailableTokenChains({ robinhoodVisible: true }),
      ['solana', 'robinhood'],
    );
  });

  it('uses the dedicated runtime flag as the public chain policy', () => {
    const hidden = { robinhoodUserVisibility: { enabled: false } };
    const visible = { robinhoodUserVisibility: { enabled: true } };

    assert.equal(isRobinhoodUserVisible(hidden), false);
    assert.equal(isTokenChainUserVisible('robinhood', hidden), false);
    assert.equal(isTokenChainUserVisible('solana', hidden), true);
    assert.equal(isRobinhoodUserVisible(visible), true);
    assert.equal(isTokenChainUserVisible('robinhood', visible), true);
  });
});
