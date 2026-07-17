const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodSignalDryRunEvaluator,
  normalizeRobinhoodSignalConfig,
} = require('../src/services/robinhood-signal-policy');
const { ROBINHOOD_TOKENIZED_ASSETS } = require('../src/services/robinhood-market-policy');
const { ROBINHOOD_USDG } = require('../src/services/evm-market-metrics');

const TOKEN = '0x1111111111111111111111111111111111111111';
const NOW = Date.parse('2026-07-13T12:00:00.000Z');
const CONFIG = {
  enabled: true,
  protocols: ['uniswap-v2'],
  windowMs: 5 * 60 * 1000,
  minLiquidityUsd: '10000',
  minVolumeUsd: '5000',
  minTransactions: 10,
  maxAgeMs: 5 * 60 * 1000,
};

function candidate(overrides = {}) {
  return {
    chain: 'robinhood',
    protocol: 'uniswap-v2',
    marketKey: `robinhood:uniswap-v2:0x${'2'.repeat(40)}`,
    tokenAddress: TOKEN,
    quoteAddress: ROBINHOOD_USDG,
    windowMs: CONFIG.windowMs,
    liquidityUsd: '15000',
    volumeUsd: '6000',
    transactions: 12,
    discoveredAt: new Date(NOW - (2 * 60 * 1000)).toISOString(),
    ...overrides,
  };
}

function evaluator(overrides = {}) {
  return createRobinhoodSignalDryRunEvaluator({
    config: CONFIG,
    now: () => NOW,
    adminBlocklist: { hasAddress: async () => false },
    ...overrides,
  });
}

describe('Robinhood signal dry-run policy', () => {
  it('stays disabled and incomplete without explicit thresholds', async () => {
    const service = createRobinhoodSignalDryRunEvaluator();
    assert.equal(service.getConfig().configured, false);
    assert.deepEqual(service.getConfig().missingFields, [
      'windowMs', 'minVolumeUsd', 'minTransactions', 'maxAgeMs',
    ]);
    assert.equal((await service.evaluate(candidate())).reasons[0], 'dry_run_disabled');
  });

  it('marks an eligible candidate as expected without ever making it publishable', async () => {
    const calls = [];
    const result = await evaluator({
      adminBlocklist: { hasAddress: async (...args) => { calls.push(args); return false; } },
    }).evaluate(candidate());

    assert.equal(result.expectedSignal, true);
    assert.equal(result.publishable, false);
    assert.equal(result.mode, 'dry-run');
    assert.deepEqual(calls, [[TOKEN, 'robinhood']]);
    assert.ok(result.gates.every((gate) => gate.passed));
  });

  it('keeps liquidity informational while enforcing volume, transactions, and age', async () => {
    const result = await evaluator().evaluate(candidate({
      liquidityUsd: null,
      liquidityCoverage: 'partial',
      liquidityStatus: 'partial_protocol_coverage',
      volumeUsd: '4999.99',
      transactions: 9,
      discoveredAt: new Date(NOW - CONFIG.maxAgeMs - 1).toISOString(),
    }));

    assert.equal(result.expectedSignal, false);
    assert.deepEqual(result.reasons, [
      'below_volume_usd', 'below_transactions', 'above_age',
    ]);
    assert.equal(result.liquidity.gateApplied, false);
    assert.equal(result.liquidity.reason, 'multiprotocol_liquidity_gate_disabled');
  });

  it('accepts a V3 primary market because protocol totals are aggregate', async () => {
    const result = await evaluator().evaluate(candidate({
      protocol: 'uniswap-v3',
      marketKey: `robinhood:uniswap-v3:0x${'2'.repeat(40)}`,
      liquidityUsd: null,
      liquidityCoverage: 'partial',
      liquidityStatus: 'partial_protocol_coverage',
    }));

    assert.equal(result.expectedSignal, true);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.config.protocols, ['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
  });

  it('applies official eligibility and the admin blocklist before market gates', async () => {
    const tokenized = await evaluator().evaluate(candidate({
      tokenAddress: ROBINHOOD_TOKENIZED_ASSETS.AAPL,
    }));
    assert.equal(tokenized.reasons[0], 'robinhood_tokenized_asset');

    const blocked = await evaluator({
      adminBlocklist: { hasAddress: async (_address, chain) => chain === 'robinhood' },
    }).evaluate(candidate());
    assert.equal(blocked.reasons[0], 'admin_blocked');
    assert.equal(blocked.gates.length, 0);
  });

  it('fails closed when candidate metrics use another window or an invalid quote', async () => {
    const wrongWindow = await evaluator().evaluate(candidate({ windowMs: 60_000 }));
    assert.equal(wrongWindow.reasons[0], 'window_mismatch');

    const invalidQuote = await evaluator().evaluate(candidate({ quoteAddress: 'invalid' }));
    assert.equal(invalidQuote.reasons[0], 'invalid_quote_address');

    const unavailableBlocklist = await createRobinhoodSignalDryRunEvaluator({
      config: CONFIG,
      now: () => NOW,
    }).evaluate(candidate());
    assert.equal(unavailableBlocklist.reasons[0], 'admin_blocklist_unavailable');
  });

  it('rejects invalid threshold configuration instead of silently coercing it', () => {
    assert.throws(
      () => normalizeRobinhoodSignalConfig({ ...CONFIG, minTransactions: 1.5 }),
      /minTransactions must be a non-negative safe integer/
    );
    assert.throws(
      () => normalizeRobinhoodSignalConfig({ ...CONFIG, minLiquidityUsd: '-1' }),
      /minLiquidityUsd must be non-negative/
    );
    assert.throws(
      () => normalizeRobinhoodSignalConfig({ ...CONFIG, windowMs: 90_000 }),
      /windowMs must be a whole minute/
    );
    assert.throws(
      () => normalizeRobinhoodSignalConfig({ ...CONFIG, maxAgeMs: 300_001 }),
      /maxAgeMs must be at most 300000/
    );
    assert.throws(
      () => normalizeRobinhoodSignalConfig({ ...CONFIG, protocols: ['uniswap-v5'] }),
      /unsupported Robinhood signal protocols/
    );
  });
});
