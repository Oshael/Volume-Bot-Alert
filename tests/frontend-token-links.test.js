const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const SOLANA = 'So11111111111111111111111111111111111111112';
const ROBINHOOD = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';

let tokenChain;

before(async () => {
  tokenChain = await import('../frontend/src/utils/token-chain.ts');
});

describe('frontend chain-validated token links', () => {
  it('builds explorers only for approved chains with valid addresses', () => {
    assert.equal(tokenChain.buildTokenExplorerUrl('solana', SOLANA), `https://solscan.io/token/${SOLANA}`);
    assert.equal(
      tokenChain.buildTokenExplorerUrl('robinhood', ROBINHOOD),
      `https://robinhoodchain.blockscout.com/address/${ROBINHOOD.toLowerCase()}`,
    );
    assert.equal(tokenChain.buildTokenExplorerUrl('robinhood', SOLANA), null);
    assert.equal(tokenChain.buildTokenExplorerUrl('base', ROBINHOOD), null);
  });

  it('accepts only approved Solana market origins and paths', () => {
    assert.equal(
      tokenChain.buildTokenMarketUrl('solana', SOLANA, 'https://dexscreener.com/solana/pair-1'),
      'https://dexscreener.com/solana/pair-1',
    );
    assert.equal(
      tokenChain.buildTokenMarketUrl('solana', SOLANA, `https://gmgn.ai/sol/token/${SOLANA}`),
      `https://gmgn.ai/sol/token/${SOLANA}`,
    );
  });

  it('rejects malformed, unsafe and chain-mismatched stored market URLs', () => {
    const rejected = [
      'http://dexscreener.com/solana/pair-1',
      'https://attacker.example/solana/pair-1',
      'https://evil.dexscreener.com/solana/pair-1',
      'https://dexscreener.com/base/pair-1',
      'https://dexscreener.com/solana/pair-1?redirect=https://attacker.example',
      'https://user:secret@dexscreener.com/solana/pair-1',
    ];
    for (const pairUrl of rejected) {
      assert.equal(
        tokenChain.buildTokenMarketUrl('solana', SOLANA, pairUrl),
        `https://dexscreener.com/solana/${SOLANA}`,
      );
    }
  });

  it('falls back by chain without leaking a Solana destination to Robinhood', () => {
    assert.equal(
      tokenChain.buildTokenMarketUrl('solana', SOLANA),
      `https://dexscreener.com/solana/${SOLANA}`,
    );
    assert.equal(
      tokenChain.buildTokenMarketUrl('robinhood', ROBINHOOD, 'https://dexscreener.com/solana/pair-1'),
      null,
    );
    assert.equal(tokenChain.buildTokenMarketUrl('robinhood', ROBINHOOD), null);
  });
});
