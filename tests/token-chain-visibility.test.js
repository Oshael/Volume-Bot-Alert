const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTokenChainVisibilityMiddleware,
  __private: { referencesRobinhood },
} = require('../src/middleware/token-chain-visibility');
const dashboardRoutes = require('../src/routes/dashboard');

function invoke(runtimeConfig, request) {
  let nextCalled = false;
  let response = null;
  const middleware = createTokenChainVisibilityMiddleware(runtimeConfig);
  middleware(request, {
    status(status) {
      return {
        json(body) {
          response = { status, body };
          return response;
        },
      };
    },
  }, () => {
    nextCalled = true;
  });
  return { nextCalled, response };
}

describe('token chain visibility middleware', () => {
  it('detects Robinhood in chain lists and canonical identities', () => {
    assert.equal(referencesRobinhood({ chain: 'robinhood' }), true);
    assert.equal(referencesRobinhood({ chains: 'solana,robinhood' }), true);
    assert.equal(referencesRobinhood({ identities: ['robinhood:0xabc'] }), true);
    assert.equal(referencesRobinhood({ nested: { chain: 'solana' } }), false);
    assert.equal(referencesRobinhood({ label: 'Robinhood' }), false);
    assert.equal(referencesRobinhood({ ruleKey: 'monitored-fdv' }), true);
    assert.equal(referencesRobinhood({ ruleKeys: ['monitored-vol', 'robinhood-hvnc-v2'] }), true);
    assert.equal(referencesRobinhood({ ruleKey: 'monitored-vol' }), false);
  });

  it('rejects explicit Robinhood requests while visibility is disabled', () => {
    const result = invoke(
      { robinhoodUserVisibility: { enabled: false } },
      { query: { chains: ['solana', 'robinhood'] }, body: {} },
    );

    assert.equal(result.nextCalled, false);
    assert.deepEqual(result.response, {
      status: 400,
      body: {
        error: 'Requested chain is not available',
        code: 'CHAIN_NOT_AVAILABLE',
      },
    });
  });

  it('allows Solana requests and all chains after explicit enablement', () => {
    assert.equal(invoke(
      { robinhoodUserVisibility: { enabled: false } },
      { query: { chain: 'solana' }, body: {} },
    ).nextCalled, true);
    assert.equal(invoke(
      { robinhoodUserVisibility: { enabled: true } },
      { query: {}, body: { chain: 'robinhood' } },
    ).nextCalled, true);
  });

  it('scopes implicit alert feeds to Solana while Robinhood is hidden', () => {
    const hidden = { robinhoodUserVisibility: { enabled: false } };
    const visible = { robinhoodUserVisibility: { enabled: true } };
    const hiddenRuleKeys = dashboardRoutes.__private.resolvePublicAlertRuleKeys(undefined, hidden);

    assert.deepEqual(
      dashboardRoutes.__private.resolvePublicAlertChains(undefined, hidden),
      ['solana'],
    );
    assert.equal(hiddenRuleKeys.includes('monitored-fdv'), false);
    assert.equal(hiddenRuleKeys.includes('robinhood-hvnc-v2'), false);
    assert.equal(hiddenRuleKeys.includes('monitored-vol'), true);
    assert.equal(dashboardRoutes.__private.resolvePublicAlertChains(undefined, visible), undefined);
    assert.equal(dashboardRoutes.__private.resolvePublicAlertRuleKeys(undefined, visible), undefined);
  });
});
