const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTokenIdentity,
  normalizeTokenAddress,
  normalizeTokenChain,
  parseTokenIdentityKey,
  tokenIdentityKey,
} = require('../src/utils/token-identity');

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM_MIXED = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const EVM_LOWER = EVM_MIXED.toLowerCase();

describe('chain-aware token identity', () => {
  it('normalizes canonical chains and explicit legacy aliases without fallback', () => {
    assert.equal(normalizeTokenChain(' ROBINHOOD '), 'robinhood');
    assert.equal(normalizeTokenChain('sol'), 'solana');
    assert.equal(normalizeTokenChain('ETH'), 'ethereum');
    assert.throws(() => normalizeTokenChain(''), /required/);
    assert.throws(() => normalizeTokenChain('unknown'), /Unsupported token chain/);
  });

  it('lowercases EVM addresses while preserving case-sensitive Solana addresses', () => {
    assert.equal(normalizeTokenAddress('robinhood', EVM_MIXED), EVM_LOWER);
    assert.equal(normalizeTokenAddress('base', EVM_MIXED), EVM_LOWER);
    assert.equal(normalizeTokenAddress('solana', SOLANA), SOLANA);
    assert.throws(() => normalizeTokenAddress('robinhood', SOLANA), /Invalid robinhood/);
    assert.throws(() => normalizeTokenAddress('solana', EVM_MIXED), /Invalid solana/);
  });

  it('builds different stable keys for the same address on different EVM chains', () => {
    assert.equal(tokenIdentityKey('robinhood', EVM_MIXED), `robinhood:${EVM_LOWER}`);
    assert.equal(tokenIdentityKey('base', EVM_MIXED), `base:${EVM_LOWER}`);
    assert.notEqual(tokenIdentityKey('robinhood', EVM_MIXED), tokenIdentityKey('base', EVM_MIXED));
  });

  it('round-trips an immutable identity key', () => {
    const identity = createTokenIdentity('robinhood', EVM_MIXED);

    assert.deepEqual(identity, { chain: 'robinhood', address: EVM_LOWER, key: `robinhood:${EVM_LOWER}` });
    assert.equal(Object.isFrozen(identity), true);
    assert.deepEqual(parseTokenIdentityKey(identity.key), identity);
    assert.throws(() => parseTokenIdentityKey('robinhood'), /Invalid token identity key/);
  });
});
