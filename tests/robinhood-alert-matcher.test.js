const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { ROBINHOOD_USDG } = require('../src/services/evm-market-metrics');
const {
  RULE_KEY,
  createRobinhoodAlertMatcher,
} = require('../src/services/robinhood-alert-matcher');

const TOKEN = '0x1111111111111111111111111111111111111111';
const PAIR = '0x2222222222222222222222222222222222222222';

function candidate(overrides = {}) {
  return {
    chain: 'robinhood',
    protocol: 'uniswap-v2',
    marketKey: `robinhood:uniswap-v2:${PAIR}`,
    tokenAddress: TOKEN,
    quoteAddress: ROBINHOOD_USDG,
    discoveredAt: '2026-07-14T17:00:00.000Z',
    windowMs: 300000,
    windowStart: '2026-07-14T17:55:00.000Z',
    windowEnd: '2026-07-14T18:00:00.000Z',
    liquidityUsd: '5000',
    volumeUsd: '350000',
    transactions: 15,
    liquidityCoverage: 'partial',
    liquidityStatus: 'partial_protocol_coverage',
    protocolBreakdown: {
      'uniswap-v2': { volumeUsd: '100000', swaps: '5', transactions: '4', markets: '1' },
      'uniswap-v3': { volumeUsd: '250000', swaps: '12', transactions: '11', markets: '1' },
    },
    marketBreakdown: [],
    lastPriceUsd: '1.2',
    lastFdvUsd: '500000',
    ...overrides,
  };
}

function decision(value = candidate(), overrides = {}) {
  return {
    chain: value.chain,
    protocol: value.protocol,
    marketKey: value.marketKey,
    tokenAddress: value.tokenAddress,
    expectedSignal: true,
    publishable: true,
    ...overrides,
  };
}

describe('Robinhood alert matcher', () => {
  it('fails closed before validating or evaluating profiles', () => {
    const matcher = createRobinhoodAlertMatcher();

    assert.equal(matcher.match({}).reason, 'alerts_disabled');
    assert.equal(matcher.match({ alertsRequested: true }).reason, 'rollout_not_publishable');
    assert.equal(matcher.match({
      alertsRequested: true,
      publishable: true,
      decision: { publishable: false },
    }).reason, 'decision_not_publishable');
  });

  it('builds one stable HVNC intent per eligible active profile', () => {
    const value = candidate();
    const result = createRobinhoodAlertMatcher().match({
      alertsRequested: true,
      publishable: true,
      candidate: value,
      decision: decision(value),
      profiles: [
        { userId: 7, ruleEnabled: { hvnc: true } },
        { userId: 8, ruleEnabled: { hvnc: false } },
        { userId: null, ruleEnabled: { hvnc: true } },
      ],
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.evaluatedProfiles, 3);
    assert.equal(result.matchedProfiles, 1);
    assert.equal(result.intents[0].ruleKey, RULE_KEY);
    assert.equal(result.intents[0].dedupeKey, `7:${RULE_KEY}:robinhood:${TOKEN}`);
    assert.equal(result.intents[0].payload.mcap, null);
    assert.equal(result.intents[0].payload.fdv, 500000);
    assert.equal(result.intents[0].payload.valuationType, 'fdv');
    assert.equal(result.intents[0].payload.volume5m, 350000);
    assert.equal(result.intents[0].payload.volume24h, null);
    assert.equal(result.intents[0].payload.aggregation, 'token-multiprotocol');
    assert.deepEqual(result.intents[0].payload.protocols, ['uniswap-v2', 'uniswap-v3']);
    assert.equal(result.intents[0].payload.liquidityCoverage, 'partial');
  });

  it('applies each profile HVNC minimum volume and defaults it to $300K', () => {
    const value = candidate({ volumeUsd: '2000' });
    const result = createRobinhoodAlertMatcher().match({
      alertsRequested: true,
      publishable: true,
      candidate: value,
      decision: decision(value),
      profiles: [
        { userId: 7, ruleEnabled: { hvnc: true } },
        { userId: 8, ruleEnabled: { hvnc: true }, hvncMinVol: 1500 },
        { userId: 9, ruleEnabled: { hvnc: false }, hvncMinVol: 1000 },
      ],
    });

    assert.equal(result.evaluatedProfiles, 3);
    assert.equal(result.matchedProfiles, 1);
    assert.deepEqual(result.intents.map((intent) => intent.userId), [8]);
  });

  it('accepts V3 primary markets and rejects protocol or identity mismatches', () => {
    const value = candidate();
    const matcher = createRobinhoodAlertMatcher();
    const input = {
      alertsRequested: true,
      publishable: true,
      candidate: value,
      decision: decision(value),
      profiles: [{ userId: 7, ruleEnabled: { hvnc: true } }],
    };

    const v3 = candidate({
      protocol: 'uniswap-v3',
      marketKey: `robinhood:uniswap-v3:${PAIR}`,
    });
    assert.equal(matcher.match({ ...input, candidate: v3, decision: decision(v3) }).status, 'completed');
    assert.throws(() => matcher.match({
      ...input,
      candidate: v3,
      decision: decision(v3, { protocol: 'uniswap-v2' }),
    }), /protocol is invalid or mismatched/);
    assert.throws(
      () => matcher.match({ ...input, decision: { ...input.decision, tokenAddress: PAIR } }),
      /token does not match/,
    );
  });
});
