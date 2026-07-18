const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { ROBINHOOD_USDG } = require('../src/services/evm-market-metrics');
const {
  createRobinhoodAlertPublicationBatch,
  __private,
} = require('../src/services/robinhood-alert-publication-batch');

const SIGNAL_CONFIG = Object.freeze({
  protocols: ['uniswap-v2'],
  windowMs: 300000,
  minLiquidityUsd: '3000',
  minVolumeUsd: '1000',
  minTransactions: 10,
  maxAgeMs: 5 * 60 * 1000,
});

function candidate(overrides = {}) {
  return {
    chain: 'robinhood',
    protocol: 'uniswap-v2',
    marketKey: 'robinhood:uniswap-v2:0x2222222222222222222222222222222222222222',
    tokenAddress: '0x1111111111111111111111111111111111111111',
    quoteAddress: ROBINHOOD_USDG,
    discoveredAt: '2026-07-14T17:58:00.000Z',
    windowMs: 300000,
    windowStart: '2026-07-14T17:55:00.000Z',
    windowEnd: '2026-07-14T18:00:00.000Z',
    liquidityUsd: '5000',
    liquidityCoverage: 'complete',
    liquidityStatus: 'spot_estimate_from_double_quote_reserve',
    volumeUsd: '350000',
    swaps: 15,
    transactions: 15,
    lastPriceUsd: '1.2',
    lastFdvUsd: '500000',
    lastObservedAt: '2026-07-14T17:59:00.000Z',
    adminBlocked: false,
    protocolBreakdown: {
      'uniswap-v2': { volumeUsd: '350000', swaps: '15', transactions: '15', markets: '1' },
    },
    marketBreakdown: [],
    ...overrides,
  };
}

describe('Robinhood alert publication batch', () => {
  it('delivers more than 500 intents in bounded sequential batches', async () => {
    const calls = [];
    const delivery = {
      async deliver(input) {
        calls.push(input.intents.length);
        return {
          status: 'completed', attempted: input.intents.length,
          persisted: input.intents.length,
        };
      },
    };
    const result = await __private.deliverInBatches(
      delivery,
      Array.from({ length: 501 }, (_, index) => ({ index })),
      { alertsRequested: true, publishable: true },
    );

    assert.deepEqual(calls, [500, 1]);
    assert.equal(result.attempted, 501);
    assert.equal(result.persisted, 501);
  });

  it('shadow-evaluates committed custom-rule observations without delivery', async () => {
    let profileReads = 0;
    let deliveries = 0;
    let customEvaluations = 0;
    const batch = createRobinhoodAlertPublicationBatch({
      userAlertProfileCache: {
        listActiveProfiles: async () => { profileReads += 1; return []; },
      },
      delivery: {
        deliver: async () => { deliveries += 1; return {}; },
      },
      customAlertAdapter: {
        evaluate: async (candidates) => {
          customEvaluations += 1;
          assert.equal(candidates.length, 1);
          return { evaluatedRules: 3, matchedRules: 1, intents: [{ customRuleId: 81 }] };
        },
      },
      stagingOptions: {
        repository: { listSignalDryRunCandidates: async () => [candidate()] },
      },
    });

    const result = await batch.runOnce({
      alertsRequested: true,
      publishable: false,
      signalConfig: SIGNAL_CONFIG,
    });

    assert.equal(result.status, 'shadow');
    assert.equal(result.reason, 'rollout_not_publishable');
    assert.equal(result.queried, 1);
    assert.equal(result.publication.mode, 'shadow');
    assert.equal(result.publication.evaluatedCustomRules, 3);
    assert.equal(result.publication.matchedCustomRules, 1);
    assert.equal(result.publication.intents, 1);
    assert.equal(result.publication.delivery.reason, 'shadow_only');
    assert.equal(result.publication.delivery.attempted, 0);
    assert.equal(profileReads, 0);
    assert.equal(deliveries, 0);
    assert.equal(customEvaluations, 1);
  });

  it('delivers an approved aggregate V3/V4 signal without legacy V2 catalog staging', async () => {
    const delivered = [];
    const value = candidate({
      protocol: 'uniswap-v3',
      marketKey: 'robinhood:uniswap-v3:0x3333333333333333333333333333333333333333',
      liquidityUsd: null,
      liquidityCoverage: 'partial',
      liquidityStatus: 'partial_protocol_coverage',
      protocolBreakdown: {
        'uniswap-v3': { volumeUsd: '250000', swaps: '10', transactions: '10', markets: '1' },
        'uniswap-v4': { volumeUsd: '100000', swaps: '5', transactions: '5', markets: '1' },
      },
    });
    const batch = createRobinhoodAlertPublicationBatch({
      userAlertProfileCache: {
        listActiveProfiles: async () => [
          { userId: 7, ruleEnabled: { hvnc: true } },
          { userId: 8, ruleEnabled: { hvnc: false } },
        ],
      },
      delivery: {
        async deliver(input) {
          delivered.push(...input.intents);
          return { status: 'completed', persisted: input.intents.length };
        },
      },
      customAlertAdapter: {
        evaluate: async () => ({ evaluatedRules: 0, matchedRules: 0, intents: [] }),
      },
      stagingOptions: {
        repository: { listSignalDryRunCandidates: async () => [value] },
        projector: {
          stage: async () => { throw new Error('V3 aggregate must not enter legacy projector'); },
        },
        now: () => Date.parse('2026-07-14T18:00:00.000Z'),
      },
    });

    const result = await batch.runOnce({
      alertsRequested: true,
      publishable: true,
      signalConfig: SIGNAL_CONFIG,
    });

    assert.equal(result.staged, 0);
    assert.equal(result.expectedSignals, 1);
    assert.equal(result.publication.evaluatedProfiles, 2);
    assert.equal(result.publication.matchedProfiles, 1);
    assert.equal(result.publication.intents, 1);
    assert.equal(result.publication.delivery.persisted, 1);
    assert.equal(delivered[0].userId, 7);
    assert.equal(delivered[0].payload.aggregation, 'token-multiprotocol');
    assert.equal(delivered[0].payload.protocol, 'uniswap-v3');
    assert.deepEqual(delivered[0].payload.protocols, ['uniswap-v3', 'uniswap-v4']);
    assert.equal(delivered[0].payload.volume5m, 350000);
    assert.equal(delivered[0].payload.liquidityUsd, null);
    assert.equal(delivered[0].payload.liquidityCoverage, 'partial');
  });

  it('publishes preloaded candidates without invoking the global candidate reader', async () => {
    const delivered = [];
    const value = candidate();
    const batch = createRobinhoodAlertPublicationBatch({
      userAlertProfileCache: {
        listActiveProfiles: async () => [{ userId: 7, ruleEnabled: { hvnc: true } }],
      },
      delivery: {
        async deliver(input) {
          delivered.push(...input.intents);
          return { status: 'completed', persisted: input.intents.length };
        },
      },
      customAlertAdapter: {
        evaluate: async () => ({ evaluatedRules: 0, matchedRules: 0, intents: [] }),
      },
      stagingOptions: {
        repository: {
          async listSignalDryRunCandidates() { throw new Error('global read is forbidden'); },
        },
        now: () => Date.parse('2026-07-14T18:00:00.000Z'),
      },
    });

    const result = await batch.runCandidates([value], {
      alertsRequested: true,
      publishable: true,
      signalConfig: SIGNAL_CONFIG,
    });

    assert.equal(result.queried, 1);
    assert.equal(result.publication.intents, 1);
    assert.equal(result.publication.delivery.persisted, 1);
    assert.equal(delivered[0].tokenAddress, value.tokenAddress);
  });

  it('evaluates custom FDV rules from committed candidates even when HVNC is suppressed', async () => {
    const delivered = [];
    let value = candidate({ volumeUsd: '100', transactions: 1 });
    const batch = createRobinhoodAlertPublicationBatch({
      userCustomAlertRule: {
        async listActiveByTokenIdentities(identities) {
          assert.deepEqual(identities, [{ chain: 'robinhood', address: value.tokenAddress }]);
          return [{
            id: 81, userId: 7, chain: 'robinhood', tokenAddress: value.tokenAddress,
            metric: 'fdv', window: 'spot', operator: 'cross_above', targetValue: 450000,
            status: 'active', metadata: {
              baselineFdv: 400000, baselineAt: '2026-07-14T17:58:00.000Z',
            },
          }];
        },
      },
      delivery: {
        async deliver(input) {
          delivered.push(...input.intents);
          return { status: 'completed', persisted: input.intents.length };
        },
      },
      stagingOptions: {
        repository: { listSignalDryRunCandidates: async () => [value] },
        now: () => Date.parse('2026-07-14T18:00:00.000Z'),
      },
    });

    const result = await batch.runOnce({
      alertsRequested: true, publishable: true, signalConfig: SIGNAL_CONFIG,
    });

    assert.equal(result.expectedSignals, 0);
    assert.equal(result.publication.evaluatedCustomRules, 1);
    assert.equal(result.publication.matchedCustomRules, 1);
    assert.equal(result.publication.intents, 1);
    assert.equal(delivered[0].customRuleId, 81);
    assert.equal(delivered[0].payload.customMetric, 'FDV');
    assert.equal(delivered[0].payload.mcap, null);
    assert.equal(delivered[0].payload.fdv, 500000);

    value = candidate({
      volumeUsd: '100', transactions: 1,
      lastObservedAt: '2026-07-14T17:57:00.000Z',
    });
    const outOfOrder = await batch.runOnce({
      alertsRequested: true, publishable: true, signalConfig: SIGNAL_CONFIG,
    });
    assert.equal(outOfOrder.publication.matchedCustomRules, 0);
    assert.equal(delivered.length, 1);
  });
});
