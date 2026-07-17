const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  compareObservationOrder,
  evaluateCustomAlertRule,
  evaluateCustomAlertRules,
} = require('../src/services/custom-alert-rule-evaluator');

const SOLANA = 'So11111111111111111111111111111111111111112';
const ROBINHOOD = '0x1234567890abcdef1234567890abcdef12345678';

function rule(overrides = {}) {
  return {
    id: 7,
    userId: 9,
    chain: 'solana',
    tokenAddress: SOLANA,
    metric: 'mcap',
    window: 'spot',
    operator: 'cross_above',
    targetValue: 100,
    status: 'active',
    metadata: { baselineMcap: 90 },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    chain: 'solana',
    address: SOLANA,
    observedAt: '2026-07-16T12:00:01.000Z',
    ordering: { blockNumber: 11, logIndex: 2 },
    values: { price: 2, mcap: 110, fdv: 1000 },
    ...overrides,
  };
}

describe('custom alert rule evaluator', () => {
  it('emits a chain-neutral intent for Solana MCAP crossing above', () => {
    const result = evaluateCustomAlertRule(rule(), observation());
    assert.equal(result.matched, true);
    assert.deepEqual(result.intent, {
      ruleId: 7, userId: 9, chain: 'solana', address: SOLANA,
      metric: 'mcap', window: 'spot', operator: 'cross_above', targetValue: 100,
      previousValue: null, currentValue: 110, referenceValue: 90,
      referenceSource: 'creation_baseline',
      observedAt: '2026-07-16T12:00:01.000Z',
      ordering: { blockNumber: 11, logIndex: 2 },
    });
  });

  it('selects Robinhood FDV without reading MCAP', () => {
    const result = evaluateCustomAlertRule(rule({
      chain: 'robinhood', tokenAddress: ROBINHOOD, metric: 'fdv',
      operator: 'cross_below', targetValue: 900, metadata: { baselineFdv: 1000 },
    }), observation({
      chain: 'robinhood', address: ROBINHOOD,
      values: { price: 2, mcap: 1, fdv: 800 },
    }));
    assert.equal(result.matched, true);
    assert.equal(result.intent.metric, 'fdv');
    assert.equal(result.intent.currentValue, 800);
  });

  it('rejects chain-specific metric and window mismatches', () => {
    const cases = [
      [rule({ metric: 'fdv', metadata: { baselineFdv: 90 } }), 'unsupported_metric'],
      [rule({ chain: 'robinhood', tokenAddress: ROBINHOOD }), 'unsupported_metric'],
      [rule({ window: '5m' }), 'unsupported_window'],
    ];
    for (const [candidate, reason] of cases) {
      const current = candidate.chain === 'robinhood'
        ? observation({ chain: 'robinhood', address: ROBINHOOD }) : observation();
      assert.equal(evaluateCustomAlertRule(candidate, current).reason, reason);
    }
  });

  it('obeys the explicit operator instead of inferring direction again', () => {
    const result = evaluateCustomAlertRule(
      rule({ operator: 'cross_below', metadata: { baselineMcap: 90 } }),
      observation({ values: { mcap: 80 } }),
    );
    assert.equal(result.matched, false);
    assert.equal(result.reason, 'target_not_crossed');
  });

  it('uses the previous observation only when creation baseline is missing', () => {
    const previous = observation({
      observedAt: '2026-07-16T12:00:00.000Z',
      ordering: { blockNumber: 11, logIndex: 1 },
      values: { mcap: 90 },
    });
    const result = evaluateCustomAlertRule(rule({ metadata: {} }), observation(), previous);
    assert.equal(result.matched, true);
    assert.equal(result.intent.referenceSource, 'previous_observation');
    assert.equal(result.intent.previousValue, 90);
  });

  it('does not invent a crossing without baseline or previous value', () => {
    const result = evaluateCustomAlertRule(rule({ metadata: {} }), observation());
    assert.equal(result.matched, false);
    assert.equal(result.reason, 'reference_value_missing');
  });

  it('fails closed for inactive rules and malformed ownership', () => {
    assert.equal(evaluateCustomAlertRule(rule({ status: null }), observation()).reason,
      'rule_inactive');
    assert.equal(evaluateCustomAlertRule(rule({ id: 0 }), observation()).reason,
      'invalid_rule_owner');
    assert.equal(evaluateCustomAlertRule(rule({ userId: 0 }), observation()).reason,
      'invalid_rule_owner');
  });

  it('rejects duplicate, older, and cross-token observations', () => {
    const previous = observation({ ordering: { blockNumber: 11, logIndex: 2 } });
    assert.equal(evaluateCustomAlertRule(rule({ metadata: {} }), observation(), previous).reason,
      'duplicate_observation');
    assert.equal(evaluateCustomAlertRule(rule({ metadata: {} }), observation({
      ordering: { blockNumber: 10, logIndex: 9 },
    }), previous).reason, 'out_of_order_observation');
    assert.equal(evaluateCustomAlertRule(rule({ metadata: {} }), observation(), observation({
      chain: 'robinhood', address: ROBINHOOD,
    })).reason, 'previous_identity_mismatch');
    assert.equal(evaluateCustomAlertRule(rule(), observation({
      observedAt: null, ordering: null,
    })).reason, 'observation_position_missing');
    assert.equal(evaluateCustomAlertRule(rule({ metadata: {} }), observation(), observation({
      observedAt: null, ordering: null,
    })).reason, 'previous_observed_at_invalid');
    assert.equal(evaluateCustomAlertRule(rule(), observation({
      observedAt: null,
    })).reason, 'observed_at_invalid');
  });

  it('compares block/log ordering before timestamps', () => {
    assert.equal(compareObservationOrder(
      observation({ ordering: { blockNumber: 20, logIndex: 1 } }),
      observation({ ordering: { blockNumber: 20, logIndex: 2 }, observedAt: '2020-01-01' }),
    ), 1);
  });

  it('returns immutable batch decisions and only matched intents', () => {
    const inputRules = [rule(), rule({ id: 8, targetValue: 200 })];
    const result = evaluateCustomAlertRules({ rules: inputRules, observation: observation() });
    assert.equal(result.decisions.length, 2);
    assert.equal(result.intents.length, 1);
    assert.equal(result.intents[0].ruleId, 7);
    assert.equal(Object.isFrozen(result.intents), true);
    assert.equal(inputRules[0].status, 'active');
  });
});
