const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const quicknodeOnchainIngestion = require('../src/services/quicknode-onchain-ingestion');

function createRaydiumSummary(tokenMint, signature = '5raydiumSignature') {
  return {
    program: 'raydium-amm-v4',
    signature,
    slot: 430662183,
    tokenMint,
    tokenDelta: -47145.024304,
    wsolDelta: -1.353572323,
    estimatedSolVolume: 1.353572323,
  };
}

describe('quicknode onchain ingestion', () => {
  it('accepts a swap candidate after checking admin blocklist', async () => {
    const calls = [];
    const result = await quicknodeOnchainIngestion.evaluateTransactionSummary(
      createRaydiumSummary('AllowedMint111111111111111111111111111111111'),
      {
        adminBlockedTokenModel: {
          async listByAddresses(addresses) {
            calls.push(addresses);
            return [];
          },
        },
      },
    );

    assert.equal(result.accepted, true);
    assert.equal(result.tokenMint, 'AllowedMint111111111111111111111111111111111');
    assert.deepEqual(calls, [['AllowedMint111111111111111111111111111111111']]);
  });

  it('suppresses admin-blocked swap candidates using the real token mint', async () => {
    const blockedMint = 'BlockedMint111111111111111111111111111111111';
    const result = await quicknodeOnchainIngestion.evaluateTransactionSummary(
      createRaydiumSummary(blockedMint),
      {
        adminBlockedTokenModel: {
          async listByAddresses(addresses) {
            assert.deepEqual(addresses, [blockedMint]);
            return [{ address: blockedMint, label: 'manual-admin-block' }];
          },
        },
      },
    );

    assert.deepEqual(result, {
      accepted: false,
      skipReason: 'admin_blocked',
      tokenMint: blockedMint,
      program: 'raydium-amm-v4',
      signature: '5raydiumSignature',
    });
  });

  it('does not query the blocklist when the transaction summary is not a candidate', async () => {
    let queried = false;
    const result = await quicknodeOnchainIngestion.evaluateTransactionSummary(
      { program: 'raydium-amm-v4', tokenMint: 'MissingSignatureMint11111111111111111111111' },
      {
        adminBlockedTokenModel: {
          async listByAddresses() {
            queried = true;
            return [];
          },
        },
      },
    );

    assert.equal(result.accepted, false);
    assert.equal(result.skipReason, 'missing_signature');
    assert.equal(queried, false);
  });

  it('does not query the blocklist for candidates below the SOL volume gate', async () => {
    let queried = false;
    const result = await quicknodeOnchainIngestion.evaluateTransactionSummary(
      {
        ...createRaydiumSummary('LowVolumeMint11111111111111111111111111111111'),
        estimatedSolVolume: 0.0001,
      },
      {
        minSolVolume: 0.01,
        adminBlockedTokenModel: {
          async listByAddresses() {
            queried = true;
            return [];
          },
        },
      },
    );

    assert.equal(result.accepted, false);
    assert.equal(result.skipReason, 'low_volume');
    assert.equal(queried, false);
  });

  it('accepts stablecoin-volume candidates through the USD volume gate', async () => {
    const result = await quicknodeOnchainIngestion.evaluateTransactionSummary(
      {
        program: 'meteora-dlmm',
        signature: '5stableVolume',
        topDeltas: [
          { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', delta: -125 },
          { mint: 'StableVolumeToken1111111111111111111111111111', delta: 1000 },
        ],
      },
      {
        minUsdVolume: 1.5,
        adminBlockedTokenModel: {
          async listByAddresses(addresses) {
            assert.deepEqual(addresses, ['StableVolumeToken1111111111111111111111111111']);
            return [];
          },
        },
      },
    );

    assert.equal(result.accepted, true);
    assert.equal(result.estimatedUsdVolume, 125);
    assert.equal(result.volumeSource, 'usdc');
  });

  it('checks unique token mints once for a batch and separates accepted from blocked', async () => {
    const allowedMint = 'AllowedMint111111111111111111111111111111111';
    const blockedMint = 'BlockedMint111111111111111111111111111111111';
    const calls = [];

    const result = await quicknodeOnchainIngestion.evaluateTransactionSummaries([
      createRaydiumSummary(allowedMint, '5allowedA'),
      createRaydiumSummary(allowedMint, '5allowedB'),
      createRaydiumSummary(blockedMint, '5blocked'),
      { program: 'raydium-clmm' },
    ], {
      adminBlockedTokenModel: {
        async listByAddresses(addresses) {
          calls.push(addresses);
          return [{ address: blockedMint }];
        },
      },
    });

    assert.deepEqual(calls, [[allowedMint, blockedMint]]);
    assert.equal(result.accepted, 2);
    assert.equal(result.skipped, 2);
    assert.equal(result.blocked, 1);
    assert.equal(result.lowVolume, 0);
    assert.deepEqual(result.candidates.map((candidate) => candidate.signature), ['5allowedA', '5allowedB']);
    assert.deepEqual(
      result.skippedEvents.map((event) => event.skipReason),
      ['admin_blocked', 'missing_signature'],
    );
  });

  it('counts low-volume skips in batch summaries', async () => {
    const result = await quicknodeOnchainIngestion.evaluateTransactionSummaries([
      createRaydiumSummary('AllowedMint111111111111111111111111111111111', '5allowed'),
      {
        ...createRaydiumSummary('LowVolumeMint11111111111111111111111111111111', '5low'),
        estimatedSolVolume: 0.0001,
      },
    ], {
      minSolVolume: 0.01,
      adminBlockedTokenModel: {
        async listByAddresses(addresses) {
          assert.deepEqual(addresses, ['AllowedMint111111111111111111111111111111111']);
          return [];
        },
      },
    });

    assert.equal(result.accepted, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.lowVolume, 1);
  });
});
