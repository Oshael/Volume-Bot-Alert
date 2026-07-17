const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM_MIXED = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const EVM_LOWER = EVM_MIXED.toLowerCase();

let tokenChain;

before(async () => {
  tokenChain = await import('../frontend/src/utils/token-chain.ts');
});

describe('frontend chain-aware token identity', () => {
  it('normalizes canonical chains and explicit aliases without guessing unknown chains', () => {
    assert.equal(tokenChain.normalizeTokenChain(' ROBINHOOD '), 'robinhood');
    assert.equal(tokenChain.normalizeTokenChain('sol'), 'solana');
    assert.equal(tokenChain.normalizeTokenChain('ETH'), 'ethereum');
    assert.equal(tokenChain.normalizeTokenChain('unknown'), null);
    assert.throws(() => tokenChain.requireTokenChain(''), /required/);
    assert.throws(() => tokenChain.requireTokenChain('unknown'), /Unsupported token chain/);
  });

  it('normalizes addresses according to the selected chain', () => {
    assert.equal(tokenChain.normalizeTokenAddress('robinhood', EVM_MIXED), EVM_LOWER);
    assert.equal(tokenChain.normalizeTokenAddress('base', EVM_MIXED), EVM_LOWER);
    assert.equal(tokenChain.normalizeTokenAddress('solana', SOLANA), SOLANA);
    assert.throws(() => tokenChain.normalizeTokenAddress('robinhood', SOLANA), /Invalid robinhood/);
    assert.throws(() => tokenChain.normalizeTokenAddress('solana', EVM_MIXED), /Invalid solana/);
  });

  it('builds and parses stable chain-scoped identity keys', () => {
    const identity = tokenChain.createTokenIdentity('robinhood', EVM_MIXED);

    assert.deepEqual(identity, {
      chain: 'robinhood',
      address: EVM_LOWER,
      key: `robinhood:${EVM_LOWER}`,
    });
    assert.equal(Object.isFrozen(identity), true);
    assert.equal(tokenChain.buildTokenIdentityKey('base', EVM_MIXED), `base:${EVM_LOWER}`);
    assert.notEqual(identity.key, tokenChain.buildTokenIdentityKey('base', EVM_MIXED));
    assert.deepEqual(tokenChain.parseTokenIdentityKey(identity.key), identity);
    assert.throws(() => tokenChain.parseTokenIdentityKey('robinhood'), /Invalid token identity key/);
  });

  it('defaults only a missing legacy payload chain to Solana', () => {
    assert.equal(
      tokenChain.createLegacyCompatibleTokenIdentity(null, SOLANA).key,
      `solana:${SOLANA}`,
    );
    assert.throws(
      () => tokenChain.createLegacyCompatibleTokenIdentity('unknown', SOLANA),
      /Unsupported token chain/,
    );
  });

  it('migrates stored legacy Solana addresses while preserving chain-scoped identities', () => {
    assert.deepEqual(tokenChain.normalizeStoredTokenIdentityKeys([
      SOLANA,
      `solana:${SOLANA}`,
      { chain: 'robinhood', address: EVM_MIXED },
      { key: `robinhood:${EVM_LOWER}` },
      'corrupt',
    ]), [
      `solana:${SOLANA}`,
      `robinhood:${EVM_LOWER}`,
    ]);
  });

  it('keeps the same EVM address isolated in identity-keyed collections', () => {
    const baseKey = tokenChain.buildTokenIdentityKey('base', EVM_MIXED);
    const robinhoodKey = tokenChain.buildTokenIdentityKey('robinhood', EVM_MIXED);
    const collection = new Map([
      [baseKey, 'BASE'],
      [robinhoodKey, 'RH'],
    ]);

    assert.equal(collection.size, 2);
    assert.equal(collection.get(baseKey), 'BASE');
    assert.equal(collection.get(robinhoodKey), 'RH');
  });

  it('normalizes the backend chain availability contract without allowing an empty selection', () => {
    assert.deepEqual(
      tokenChain.normalizeAvailableTokenChains(['solana', 'ROBINHOOD', 'sol', 'unknown']),
      ['solana', 'robinhood'],
    );
    assert.deepEqual(tokenChain.normalizeAvailableTokenChains([]), ['solana']);
    assert.deepEqual(tokenChain.normalizeAvailableTokenChains(null), ['solana']);
  });

  it('normalizes independent chain filters as subsets of the master selection', () => {
    assert.deepEqual(
      tokenChain.normalizeChainFilterPreferences({
        enabledChains: ['solana', 'robinhood'],
        radarChains: ['solana'],
        alertFeedChains: ['solana', 'robinhood'],
        browserNotificationChains: ['robinhood', 'base'],
      }, ['solana', 'robinhood']),
      {
        enabledChains: ['solana', 'robinhood'],
        radarChains: ['solana'],
        alertFeedChains: ['solana', 'robinhood'],
        browserNotificationChains: ['robinhood'],
      },
    );
  });

  it('toggles only available master chains without allowing an empty selection', () => {
    const solanaOnly = {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    };
    assert.deepEqual(
      tokenChain.toggleEnabledTokenChain(solanaOnly, ['solana'], 'solana'),
      solanaOnly,
    );
    assert.deepEqual(
      tokenChain.toggleEnabledTokenChain(solanaOnly, ['solana'], 'robinhood'),
      solanaOnly,
    );

    const withRobinhood = tokenChain.toggleEnabledTokenChain(
      solanaOnly,
      ['solana', 'robinhood'],
      'robinhood',
    );
    assert.deepEqual(withRobinhood, {
      ...solanaOnly,
      enabledChains: ['solana', 'robinhood'],
    });
    assert.deepEqual(
      tokenChain.toggleEnabledTokenChain(withRobinhood, ['solana', 'robinhood'], 'solana'),
      {
        enabledChains: ['robinhood'],
        radarChains: ['robinhood'],
        alertFeedChains: ['robinhood'],
        browserNotificationChains: ['robinhood'],
      },
    );
  });

  it('toggles surface chains only inside the master filter and keeps every surface non-empty', () => {
    const preferences = {
      enabledChains: ['solana', 'robinhood'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['robinhood'],
    };
    const availableChains = ['solana', 'robinhood', 'base'];

    const bothFeedChains = tokenChain.toggleTokenChainForSurface(
      preferences,
      availableChains,
      'alertFeedChains',
      'robinhood',
    );
    assert.deepEqual(bothFeedChains.alertFeedChains, ['solana', 'robinhood']);
    assert.deepEqual(bothFeedChains.browserNotificationChains, ['robinhood']);

    const robinhoodOnlyFeed = tokenChain.toggleTokenChainForSurface(
      bothFeedChains,
      availableChains,
      'alertFeedChains',
      'solana',
    );
    assert.deepEqual(robinhoodOnlyFeed.alertFeedChains, ['robinhood']);
    assert.deepEqual(
      tokenChain.toggleTokenChainForSurface(
        robinhoodOnlyFeed,
        availableChains,
        'alertFeedChains',
        'robinhood',
      ).alertFeedChains,
      ['robinhood'],
    );
    assert.deepEqual(
      tokenChain.toggleTokenChainForSurface(
        preferences,
        availableChains,
        'browserNotificationChains',
        'base',
      ),
      preferences,
    );
  });

  it('filters surfaces independently without mutating the cached collection', () => {
    const preferences = {
      enabledChains: ['solana', 'robinhood'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['robinhood'],
    };
    const cached = [{ id: 'sol', chain: 'solana' }, { id: 'rh', chain: 'robinhood' }];

    assert.deepEqual(
      tokenChain.filterItemsByChainSelection(cached, preferences, 'alertFeedChains'),
      [{ id: 'sol', chain: 'solana' }],
    );
    assert.deepEqual(
      tokenChain.filterItemsByChainSelection(cached, preferences, 'radarChains'),
      [{ id: 'sol', chain: 'solana' }],
    );
    assert.equal(tokenChain.isTokenChainSelectedForSurface(preferences, 'browserNotificationChains', 'robinhood'), true);
    assert.equal(tokenChain.isTokenChainSelectedForSurface(preferences, 'alertFeedChains', 'robinhood'), false);
    assert.equal(cached.length, 2);
  });

  it('requires the master filter even when a surface contains the chain', () => {
    const preferences = {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['robinhood'],
    };

    assert.equal(tokenChain.isTokenChainSelectedForSurface(preferences, 'browserNotificationChains', 'robinhood'), false);
    assert.equal(tokenChain.isTokenChainSelectedForSurface(preferences, 'browserNotificationChains', 'unknown'), false);
  });

  it('filters generic workspace collections by the master selection', () => {
    const cached = [
      { id: 'legacy-sol', address: SOLANA },
      { id: 'sol', chain: 'solana', address: SOLANA },
      { id: 'rh', chain: 'robinhood', address: EVM_LOWER },
    ];
    const preferences = {
      enabledChains: ['robinhood'],
      radarChains: ['robinhood'],
      alertFeedChains: ['robinhood'],
      browserNotificationChains: ['robinhood'],
    };

    assert.deepEqual(
      tokenChain.filterItemsByEnabledChains(cached, preferences),
      [cached[2]],
    );
    assert.equal(cached.length, 3);
  });

  it('exposes an explicit notice when no selected chain supports a generic capability', () => {
    const preferences = {
      enabledChains: ['robinhood'],
      radarChains: ['robinhood'],
      alertFeedChains: ['robinhood'],
      browserNotificationChains: ['robinhood'],
    };
    const readiness = {
      robinhood: {
        chain: 'robinhood',
        status: 'syncing',
        message: 'Robinhood is syncing market coverage.',
        capabilities: { monitored: false },
      },
    };

    assert.equal(
      tokenChain.hasEnabledChainCapability(preferences, readiness, 'monitored'),
      false,
    );
    assert.equal(
      tokenChain.getUnavailableChainCapabilityNotice(preferences, readiness, 'monitored'),
      'Robinhood is syncing market coverage.',
    );
  });

});
