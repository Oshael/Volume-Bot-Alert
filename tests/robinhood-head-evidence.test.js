const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  HEAD_EVIDENCE_VERSION,
  buildMarketEvidence,
  buildDiscoveryEvidence,
} = require('../src/services/robinhood-head-evidence');

const BASE = {
  timestampMs: '1750000000000',
  tokenAddress: '0xtoken',
  quoteAddress: '0xquote',
  quoteIndex: 1,
  eligibility: { eligible: true, reason: null },
  tokenMetadata: {
    name: 'Token', symbol: 'TKN', decimals: 18,
    totalSupplyRaw: '1000000000000000000000',
    tokenSupplyStatus: 'latest_call', tokenSupplyBlockTag: '0x1a2b',
  },
  quoteMetadata: { decimals: 6 },
  quoteUsd: { priceUsd: '1.0', source: 'canonical-weth-usdg-3000', status: 'observed', blockTag: 'latest' },
};

function withProtocol(protocol, extra) {
  return { ...BASE, protocol, ...extra };
}

describe('buildMarketEvidence', () => {
  it('freezes the V3 block-anchored pool balances', () => {
    const { evidence, protocol } = buildMarketEvidence(withProtocol('uniswap-v3', {
      v3: {
        poolAddress: '0xpool', blockTag: '0x1a2b',
        tokenBalanceRaw: '500', quoteBalanceRaw: '700', sqrtPriceX96: '123',
      },
    }));
    assert.equal(protocol, 'uniswap-v3');
    assert.equal(evidence.evidenceVersion, HEAD_EVIDENCE_VERSION);
    assert.deepEqual(evidence.v3, {
      poolAddress: '0xpool', blockTag: '0x1a2b',
      balanceStatus: 'observed',
      tokenBalanceRaw: '500', quoteBalanceRaw: '700', sqrtPriceX96: '123',
    });
    assert.equal(evidence.tokenMetadata.tokenSupplyStatus, 'latest_call');
    assert.equal(evidence.quoteUsd.status, 'observed');
  });

  it('records unavailable V3 catch-up balances explicitly without inventing zero', () => {
    const { evidence } = buildMarketEvidence(withProtocol('uniswap-v3', {
      v3: {
        poolAddress: '0xpool', blockTag: '0x1a2b',
        balanceStatus: 'unavailable_backfill',
        tokenBalanceRaw: null, quoteBalanceRaw: null, sqrtPriceX96: '123',
      },
    }));
    assert.equal(evidence.v3.balanceStatus, 'unavailable_backfill');
    assert.equal(evidence.v3.tokenBalanceRaw, null);
    assert.equal(evidence.v3.quoteBalanceRaw, null);
  });

  it('captures V2 reserves from the log', () => {
    const { evidence } = buildMarketEvidence(withProtocol('uniswap-v2', {
      v2: { quoteReserveRaw: '999' },
    }));
    assert.deepEqual(evidence.v2, { quoteReserveRaw: '999' });
  });

  it('captures V4 active liquidity and signed modifyLiquidity deltas', () => {
    const { evidence } = buildMarketEvidence(withProtocol('uniswap-v4', {
      v4: {
        poolId: '0xpid', sqrtPriceX96: '42', liquidityRaw: '1000',
        modifyLiquidity: [{ tickLower: -60, tickUpper: 60, liquidityDelta: '-123' }],
      },
    }));
    assert.equal(evidence.v4.liquidityRaw, '1000');
    assert.deepEqual(evidence.v4.modifyLiquidity, [
      { tickLower: -60, tickUpper: 60, liquidityDelta: '-123' },
    ]);
  });

  it('accepts an assumed USDG peg quote', () => {
    const { evidence } = buildMarketEvidence(withProtocol('uniswap-v2', {
      v2: { quoteReserveRaw: '10' },
      quoteUsd: { priceUsd: '1', source: 'usdg-peg-assumption', status: 'assumed', blockTag: 'latest' },
    }));
    assert.equal(evidence.quoteUsd.status, 'assumed');
  });

  const failClosed = [
    ['missing V3 token balance', 'uniswap-v3', { v3: { poolAddress: '0xp', blockTag: '0x1', quoteBalanceRaw: '1' } }, /V3 token balance is required/],
    ['negative V3 balance', 'uniswap-v3', { v3: { poolAddress: '0xp', blockTag: '0x1', tokenBalanceRaw: '-1', quoteBalanceRaw: '1' } }, /must not be negative/],
    ['missing quote USD', 'uniswap-v2', { v2: { quoteReserveRaw: '1' }, quoteUsd: null }, /quote USD evidence is required/],
    ['invalid quote status', 'uniswap-v2', { v2: { quoteReserveRaw: '1' }, quoteUsd: { priceUsd: '1', source: 's', status: 'guessed', blockTag: 'latest' } }, /quote USD status is invalid/],
    ['missing supply', 'uniswap-v2', { v2: { quoteReserveRaw: '1' }, tokenMetadata: { ...BASE.tokenMetadata, totalSupplyRaw: null } }, /token totalSupply is required/],
    ['unknown protocol', 'uniswap-v9', {}, /protocol is invalid/],
  ];

  for (const [name, protocol, extra, matcher] of failClosed) {
    it(`is fail-closed: ${name}`, () => {
      assert.throws(() => buildMarketEvidence(withProtocol(protocol, extra)), matcher);
    });
  }

  it('refuses to build market evidence for an ineligible swap', () => {
    assert.throws(
      () => buildMarketEvidence(withProtocol('uniswap-v2', {
        v2: { quoteReserveRaw: '1' }, eligibility: { eligible: false, reason: 'token_ineligible' },
      })),
      /requires an eligible swap/
    );
  });
});

describe('buildDiscoveryEvidence', () => {
  it('captures the decoded event without NOXA when not a launch', () => {
    const { evidence } = buildDiscoveryEvidence({ event: { kind: 'pool-created', poolAddress: '0xp' } });
    assert.equal(evidence.event.kind, 'pool-created');
    assert.equal(evidence.noxa, undefined);
  });

  it('freezes the NOXA on-chain validation result', () => {
    const { evidence } = buildDiscoveryEvidence({
      event: { kind: 'noxa-launch', tokenAddress: '0xt' },
      noxa: {
        accepted: true, canonicalPoolAddress: '0xpool',
        tokenCodeBytes: 120, poolCodeBytes: 340, launchedToken: { poolFee: 3000 },
      },
    });
    assert.equal(evidence.noxa.accepted, true);
    assert.equal(evidence.noxa.canonicalPoolAddress, '0xpool');
    assert.equal(evidence.noxa.tokenCodeBytes, 120);
  });

  it('requires an event object', () => {
    assert.throws(() => buildDiscoveryEvidence({ event: null }), /discovery event is required/);
  });
});
