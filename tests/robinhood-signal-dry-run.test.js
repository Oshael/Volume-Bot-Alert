const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodSignalDryRunReporter } = require(
  '../src/services/robinhood-signal-dry-run'
);
const { ROBINHOOD_USDG } = require('../src/services/evm-market-metrics');

const NOW = Date.parse('2026-07-13T12:00:00.000Z');
const WINDOW_MS = 5 * 60 * 1000;
const CONFIG = {
  enabled: true,
  protocols: ['uniswap-v2'],
  windowMs: WINDOW_MS,
  minLiquidityUsd: '10000',
  minVolumeUsd: '5000',
  minTransactions: 10,
  maxAgeMs: 5 * 60 * 1000,
};

function candidate(index, overrides = {}) {
  const protocol = overrides.protocol || 'uniswap-v2';
  const tokenAddress = `0x${String(index).repeat(40)}`;
  return {
    chain: 'robinhood',
    protocol,
    marketKey: `robinhood:${protocol}:0x${String(index + 3).repeat(40)}`,
    tokenAddress,
    quoteAddress: ROBINHOOD_USDG,
    discoveredAt: '2026-07-13T11:58:00.000Z',
    windowMs: WINDOW_MS,
    windowStart: '2026-07-13T11:55:00.000Z',
    windowEnd: '2026-07-13T12:00:00.000Z',
    liquidityUsd: '15000',
    liquidityStatus: 'spot_estimate_from_double_quote_reserve',
    volumeUsd: '6000',
    swaps: 12,
    transactions: 12,
    liquidityCoverage: protocol === 'uniswap-v2' ? 'complete' : 'partial',
    protocolBreakdown: {
      [protocol]: {
        volumeUsd: '6000', swaps: '12', transactions: '12', markets: '1',
      },
    },
    lastObservedAt: '2026-07-13T11:59:00.000Z',
    adminBlocked: false,
    ...overrides,
  };
}

describe('Robinhood signal dry-run reporter', () => {
  it('does not query candidates while evaluation is disabled or incomplete', async () => {
    let reads = 0;
    const reporter = createRobinhoodSignalDryRunReporter({
      config: {},
      repository: { listSignalDryRunCandidates: async () => { reads += 1; return []; } },
      now: () => NOW,
    });

    const report = await reporter.runOnce();

    assert.equal(report.status, 'disabled');
    assert.equal(report.publishable, false);
    assert.equal(report.publicationAttempts, 0);
    assert.equal(reads, 0);
  });

  it('summarizes aggregate protocol contributions and chain-aware blocks', async () => {
    const calls = [];
    const rows = [
      candidate(1),
      candidate(2, {
        protocol: 'uniswap-v3',
        marketKey: `robinhood:uniswap-v3:0x${'5'.repeat(40)}`,
        liquidityUsd: null,
        liquidityStatus: 'requires_tick_liquidity_distribution',
      }),
      candidate(3, { adminBlocked: true }),
    ];
    const reporter = createRobinhoodSignalDryRunReporter({
      config: CONFIG,
      candidateLimit: 3,
      sampleLimit: 2,
      statementTimeoutMs: 5000,
      repository: {
        async listSignalDryRunCandidates(options) {
          calls.push(options);
          return rows;
        },
      },
      now: () => NOW,
    });

    const report = await reporter.runOnce();

    assert.equal(report.status, 'completed');
    assert.equal(report.publishable, false);
    assert.equal(report.publicationAttempts, 0);
    assert.deepEqual(report.summary, {
      candidates: 3,
      uniqueTokens: 3,
      expectedSignals: 2,
      suppressed: 1,
      byProtocol: {
        'uniswap-v2': { candidates: 2, expectedSignals: 1, suppressed: 1 },
        'uniswap-v3': { candidates: 1, expectedSignals: 1, suppressed: 0 },
      },
      byProtocolContribution: {
        'uniswap-v2': {
          tokens: 2, markets: 2, volumeUsd: 12000, swaps: 24, transactions: 24,
        },
        'uniswap-v3': {
          tokens: 1, markets: 1, volumeUsd: 6000, swaps: 12, transactions: 12,
        },
      },
      byReason: { admin_blocked: 1 },
      byLiquidityStatus: {
        spot_estimate_from_double_quote_reserve: 2,
        requires_tick_liquidity_distribution: 1,
      },
    });
    assert.equal(report.candidateLimitReached, true);
    assert.equal(report.samples.length, 2);
    assert.ok(report.samples.every((sample) => sample.publishable === false));
    assert.equal(Object.hasOwn(calls[0], 'protocols'), false);
    assert.equal(calls[0].windowMs, WINDOW_MS);
    assert.equal(calls[0].limit, 3);
    assert.equal(calls[0].statementTimeoutMs, 5000);
    assert.equal(calls[0].asOf.toISOString(), '2026-07-13T12:00:00.000Z');
  });
});
