const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { getAvailableTokenChains } = require('../src/utils/token-chain-availability');

describe('token chain availability', () => {
  it('keeps Robinhood hidden while alert activation is not requested', () => {
    assert.deepEqual(getAvailableTokenChains(), ['solana']);
    assert.deepEqual(
      getAvailableTokenChains({ robinhoodAlertsRequested: false }),
      ['solana'],
    );
  });

  it('exposes Robinhood when the rollout is configured independently from alert readiness', () => {
    assert.deepEqual(
      getAvailableTokenChains({ robinhoodAlertsRequested: true }),
      ['solana', 'robinhood'],
    );
    assert.deepEqual(
      getAvailableTokenChains({ robinhoodConfigured: true, robinhoodAlertsRequested: false }),
      ['solana', 'robinhood'],
    );
  });
});
