const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { ROBINHOOD_USDG } = require('../src/services/evm-market-metrics');
const { createRobinhoodCatalogProjector } = require(
  '../src/services/robinhood-catalog-projector'
);
const { createRobinhoodCatalogStagingBatch } = require(
  '../src/services/robinhood-catalog-staging-batch'
);

const NOW = Date.parse('2026-07-14T18:00:00.000Z');
const SIGNAL_CONFIG = Object.freeze({
  protocols: ['uniswap-v2'],
  windowMs: 300000,
  minLiquidityUsd: '3000',
  minVolumeUsd: '1000',
  minTransactions: 10,
  maxAgeMs: 5 * 60 * 1000,
});

function candidate(index, overrides = {}) {
  return {
    chain: 'robinhood',
    protocol: 'uniswap-v2',
    marketKey: `robinhood:uniswap-v2:0x${String(index + 2).repeat(40)}`,
    tokenAddress: `0x${String(index).repeat(40)}`,
    quoteAddress: ROBINHOOD_USDG,
    discoveredAt: '2026-07-14T17:58:00.000Z',
    windowMs: 300000,
    windowStart: '2026-07-14T17:55:00.000Z',
    windowEnd: '2026-07-14T18:00:00.000Z',
    liquidityUsd: '5000',
    liquidityStatus: 'spot_estimate_from_double_quote_reserve',
    volumeUsd: '2000',
    transactions: 15,
    lastPriceUsd: '1.2',
    lastFdvUsd: '500000',
    lastObservedAt: '2026-07-14T17:59:00.000Z',
    adminBlocked: false,
    ...overrides,
  };
}

describe('Robinhood catalog staging batch', () => {
  it('does not query candidates while alerts or rollout are closed', async () => {
    let reads = 0;
    const batch = createRobinhoodCatalogStagingBatch({
      repository: { listSignalDryRunCandidates: async () => { reads += 1; return []; } },
      now: () => NOW,
    });

    assert.equal((await batch.runOnce({ signalConfig: SIGNAL_CONFIG })).reason, 'alerts_disabled');
    assert.equal((await batch.runOnce({
      signalConfig: SIGNAL_CONFIG,
      alertsRequested: true,
      publishable: false,
    })).reason, 'rollout_not_publishable');
    assert.equal(reads, 0);
  });

  it('stages only policy-approved candidates after both rollout gates open', async () => {
    const staged = [];
    const rows = [candidate(1), candidate(2, { volumeUsd: '100', transactions: 2 })];
    const projector = createRobinhoodCatalogProjector({
      catalog: {
        async stageSnapshot(value) {
          staged.push(value.tokenAddress);
          return { chain: 'robinhood', address: value.tokenAddress };
        },
      },
    });
    const batch = createRobinhoodCatalogStagingBatch({
      repository: { listSignalDryRunCandidates: async () => rows },
      projector,
      now: () => NOW,
    });

    const result = await batch.runOnce({
      signalConfig: SIGNAL_CONFIG,
      alertsRequested: true,
      publishable: true,
      candidateLimit: 2,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.queried, 2);
    assert.equal(result.expectedSignals, 1);
    assert.equal(result.staged, 1);
    assert.equal(result.suppressed, 1);
    assert.equal(result.candidateLimitReached, true);
    assert.deepEqual(staged, [rows[0].tokenAddress]);
  });

  it('evaluates preloaded candidates without reading the global repository', async () => {
    const rows = [candidate(1)];
    const batch = createRobinhoodCatalogStagingBatch({
      repository: {
        async listSignalDryRunCandidates() { throw new Error('global read is forbidden'); },
      },
      projector: { async stage() { return { staged: true }; } },
      now: () => NOW,
    });

    const result = await batch.runCandidates(rows, {
      signalConfig: SIGNAL_CONFIG,
      alertsRequested: true,
      publishable: true,
    });

    assert.equal(result.queried, 1);
    assert.equal(result.expectedSignals, 1);
    assert.equal(result.staged, 1);
    assert.equal(result.candidateLimitReached, false);
  });

  it('fails closed before querying when calibrated gates are incomplete', async () => {
    let reads = 0;
    const batch = createRobinhoodCatalogStagingBatch({
      repository: { listSignalDryRunCandidates: async () => { reads += 1; return []; } },
      now: () => NOW,
    });

    const result = await batch.runOnce({
      signalConfig: { protocols: ['uniswap-v2'] },
      alertsRequested: true,
      publishable: true,
    });

    assert.equal(result.reason, 'gates_not_configured');
    assert.equal(reads, 0);
  });
});
