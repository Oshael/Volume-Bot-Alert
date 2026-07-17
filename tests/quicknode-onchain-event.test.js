const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const quicknodeOnchainEvent = require('../src/services/quicknode-onchain-event');

describe('quicknode onchain event', () => {
  it('builds a Raydium swap candidate from a transaction summary', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'raydium-amm-v4',
      signature: '5raydiumSignature',
      slot: 430662183,
      tokenMint: '5RyeWfbjVw6Ktj6j8SmTiAnVXWvmV8YxGtTebNsU2dBo',
      tokenDelta: -47145.024304,
      wsolDelta: -1.353572323,
      estimatedSolVolume: 1.353572323,
    });

    assert.equal(candidate.accepted, true);
    assert.equal(candidate.source, 'quicknode-onchain');
    assert.equal(candidate.program, 'raydium-amm-v4');
    assert.equal(candidate.tokenMint, '5RyeWfbjVw6Ktj6j8SmTiAnVXWvmV8YxGtTebNsU2dBo');
    assert.equal(candidate.estimatedSolVolume, 1.353572323);
    assert.equal(candidate.volumeSource, 'wsol');
  });

  it('suppresses admin-blocked token candidates before alert generation', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'raydium-cpmm',
      signature: '5blockedSignature',
      tokenMint: 'BlockedMint111111111111111111111111111111111',
      estimatedSolVolume: 0.4,
    }, {
      blockedTokenAddresses: ['BlockedMint111111111111111111111111111111111'],
    });

    assert.deepEqual(candidate, {
      accepted: false,
      skipReason: 'admin_blocked',
      tokenMint: 'BlockedMint111111111111111111111111111111111',
      program: 'raydium-cpmm',
      signature: '5blockedSignature',
    });
  });

  it('suppresses candidates below the configured SOL volume gate', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'pumpswap',
      signature: '5lowVolumeSignature',
      tokenMint: 'LowVolumeMint11111111111111111111111111111111',
      estimatedSolVolume: 0.0002,
    }, {
      minSolVolume: 0.01,
    });

    assert.deepEqual(candidate, {
      accepted: false,
      skipReason: 'low_volume',
      tokenMint: 'LowVolumeMint11111111111111111111111111111111',
      program: 'pumpswap',
      signature: '5lowVolumeSignature',
      estimatedSolVolume: 0.0002,
      estimatedUsdVolume: null,
      volumeSource: 'wsol',
      minSolVolume: 0.01,
      minUsdVolume: 0,
    });
  });

  it('accepts USDC volume without treating USDC as the traded token', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'meteora-dlmm',
      signature: '5stableVolumeSignature',
      topDeltas: [
        { mint: quicknodeOnchainEvent.USDC_MINT, delta: -271.07098299916834 },
        { mint: 'CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt', delta: -8079.788977 },
      ],
    }, {
      minUsdVolume: 1.5,
    });

    assert.equal(candidate.accepted, true);
    assert.equal(candidate.tokenMint, 'CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt');
    assert.equal(candidate.tokenDelta, -8079.788977);
    assert.equal(candidate.stableDelta, -271.07098299916834);
    assert.equal(candidate.estimatedUsdVolume, 271.07098299916834);
    assert.equal(candidate.volumeSource, 'usdc');
  });

  it('suppresses stablecoin routes below the configured USD volume gate', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'meteora-dlmm',
      signature: '5lowStableVolumeSignature',
      topDeltas: [
        { mint: quicknodeOnchainEvent.USDT_MINT, delta: -1.49 },
        { mint: 'StableRouteToken111111111111111111111111111111', delta: 5000 },
      ],
    }, {
      minUsdVolume: 1.5,
    });

    assert.equal(candidate.accepted, false);
    assert.equal(candidate.skipReason, 'low_volume');
    assert.equal(candidate.estimatedUsdVolume, 1.49);
    assert.equal(candidate.volumeSource, 'usdt');
  });

  it('lets admin-blocked suppression win before the volume gate', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'pumpswap',
      signature: '5blockedLowVolumeSignature',
      tokenMint: 'BlockedLowVolumeMint11111111111111111111111111',
      estimatedSolVolume: 0.0002,
    }, {
      blockedTokenAddresses: ['BlockedLowVolumeMint11111111111111111111111111'],
      minSolVolume: 0.01,
    });

    assert.equal(candidate.skipReason, 'admin_blocked');
  });

  it('falls back to the largest non-WSOL token delta when tokenMint is absent', () => {
    const candidate = quicknodeOnchainEvent.buildOnchainSwapCandidate({
      program: 'raydium-clmm',
      signature: '5fallbackSignature',
      topDeltas: [
        { mint: quicknodeOnchainEvent.WSOL_MINT, delta: -2.1 },
        { mint: quicknodeOnchainEvent.USDC_MINT, delta: 1500 },
        { mint: 'SmallMint11111111111111111111111111111111111', delta: 10 },
        { mint: 'LargeMint11111111111111111111111111111111111', delta: -250 },
      ],
      wsolDelta: -2.1,
    });

    assert.equal(candidate.accepted, true);
    assert.equal(candidate.tokenMint, 'LargeMint11111111111111111111111111111111111');
    assert.equal(candidate.estimatedSolVolume, 2.1);
  });
});
