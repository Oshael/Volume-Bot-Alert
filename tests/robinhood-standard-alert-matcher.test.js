const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  evaluateRobinhoodStandardSignal,
} = require('../src/services/robinhood-standard-alert-matcher');
const TOKEN = `0x${'1'.repeat(40)}`;
const NOW = '2026-07-19T18:00:30.000Z';
function signal(overrides = {}) {
  const base = {
    id: `robinhood:${TOKEN}:101`, chain: 'robinhood', address: TOKEN,
    generatedAt: NOW, source: 'robinhood-committed-swaps',
    volume5m: { currentUsd: 300, baselineUsd: 100, changePct: 200, coverage: 'complete' },
    valuation: {
      type: 'fdv', current: { fdvUsd: 200_000, priceUsd: 2 },
      windows: {
        '5m': { fdvUsd: 100_000, fdvChangePct: 100, coverage: 'complete' },
        '1h': { fdvUsd: 100_000, priceChangePct: 100, coverage: 'complete' },
        '6h': { fdvUsd: 50_000, priceChangePct: 300, coverage: 'complete' },
      },
    },
    tokenAge: {
      ageMs: 10 * 24 * 60 * 60 * 1000,
      eligibility: {
        minimum1h: true, recentSurge1h: false, recentSurge6h: false, oldWeekSurge: true,
      },
    },
    filters: { adminBlocked: false },
  };
  return { ...base, ...overrides };
}
function profile(userId, overrides = {}) {
  return {
    userId,
    ruleEnabled: {
      monitoredVol: false, monitoredFdv: false,
      recentSurge1h: false, recentSurge6h: false,
      oldWeekSurge1h: false, oldWeekSurge6h: false,
    },
    thresholdPct: 50, fdvThresholdPct: 50,
    minVol: 100, minFdv: 30_000, maxFdv: 0,
    recentSurge1hThresholdPct: 50, recentSurge6hThresholdPct: 100,
    oldWeekSurge1hThresholdPct: 50, oldWeekSurge6hThresholdPct: 100,
    ...overrides,
  };
}
function evaluate(input = {}) {
  return evaluateRobinhoodStandardSignal({
    signal: input.signal || signal(), profiles: input.profiles || [],
    states: input.states || [], now: NOW,
  });
}
describe('Robinhood standard alert matcher', () => {
  it('evaluates volume thresholds independently per user', () => {
    const result = evaluate({ profiles: [
      profile(1, { ruleEnabled: { monitoredVol: true }, thresholdPct: 100 }),
      profile(2, { ruleEnabled: { monitoredVol: true }, thresholdPct: 250 }),
    ] });
    assert.equal(result.evaluations[0].plans[0].action, 'emit');
    assert.equal(result.evaluations[0].plans[0].ruleKey, 'monitored-vol');
    assert.equal(result.evaluations[1].plans.length, 0);
  });

  it('uses the 5m FDV baseline and suppresses a replay against the persisted anchor', () => {
    const configured = profile(1, {
      ruleEnabled: { monitoredFdv: true }, fdvThresholdPct: 50,
    });
    const previous = {
      userId: 1, ruleKey: 'monitored-fdv', status: 'triggered', rearmRequired: true,
      lastAlertedValue: 200_000, cooldownUntil: '2026-07-19T17:59:00.000Z',
    };
    const replay = evaluate({ profiles: [configured], states: [previous] });
    assert.equal(replay.evaluations[0].plans[0].action, 'suppress');
    const changed = signal({
      valuation: {
        ...signal().valuation,
        current: { fdvUsd: 310_000, priceUsd: 3.1 },
        windows: {
          ...signal().valuation.windows,
          '5m': { fdvUsd: 100_000, fdvChangePct: 210, coverage: 'complete' },
          '1h': { fdvUsd: 300_000, priceChangePct: 1, coverage: 'complete' },
        },
      },
    });
    const advanced = evaluate({ signal: changed, profiles: [configured], states: [previous] });
    assert.equal(advanced.evaluations[0].plans[0].action, 'emit');
    assert.equal(advanced.evaluations[0].plans[0].candidate.payload.prevFdv, 100_000);
  });
  it('primes an already-hot surge, then requires fresh activity before emitting', () => {
    const recent = signal({ tokenAge: { ...signal().tokenAge, eligibility: {
      minimum1h: true, recentSurge1h: true, recentSurge6h: true, oldWeekSurge: false,
    } } });
    const recentRules = { recentSurge1h: true, recentSurge6h: true };
    assert.deepEqual(evaluate({ signal: recent, profiles: [profile(2, { ruleEnabled: recentRules })] })
      .evaluations[0].candidates.map((candidate) => candidate.ruleKey),
    ['recent-surge-6h', 'recent-surge-1h']);
    const configured = profile(1, { ruleEnabled: { oldWeekSurge1h: true } });
    const first = evaluate({ profiles: [configured] });
    assert.equal(first.evaluations[0].plans[0].action, 'prime');
    const primed = {
      userId: 1, ruleKey: 'old-week-surge-1h', status: 'triggered', rearmRequired: true,
      lastAlertedAt: null, lastAlertedPct: 100, metadata: { lastDecision: 'primed-hot' },
    };
    const hotter = signal({
      valuation: {
        ...signal().valuation,
        windows: { ...signal().valuation.windows,
          '1h': { fdvUsd: 100_000, priceChangePct: 111, coverage: 'complete' } },
      },
    });
    const next = evaluate({ signal: hotter, profiles: [configured], states: [primed] });
    assert.equal(next.evaluations[0].plans[0].action, 'emit');
  });
  it('returns a rearm plan without mutating state when an enabled rule becomes cold', () => {
    const state = {
      userId: 1, ruleKey: 'monitored-vol', status: 'triggered', rearmRequired: true,
      lastAlertedValue: 300, cooldownUntil: '2026-07-19T18:01:00.000Z',
    };
    const blocked = signal({ filters: { adminBlocked: true } });
    const result = evaluate({
      signal: blocked, profiles: [profile(1, { ruleEnabled: { monitoredVol: true } })], states: [state],
    });
    assert.equal(result.evaluations[0].plans[0].action, 'rearm');
    assert.equal(state.status, 'triggered');
  });
  it('plans the existing 3x continuation once per base 6h surge event', () => {
    const configured = profile(1, { ruleEnabled: { oldWeekSurge6h: true } });
    const base = { userId: 1, ruleKey: 'old-week-surge-6h', lastAlertedAt: '2026-07-19T16:00:00Z',
      metadata: { lastAlertedFdv: 50_000, lastEventId: 9 } };
    const result = evaluate({ profiles: [configured], states: [base] });
    assert.equal(result.evaluations[0].plans.at(-1).ruleKey, 'surge-continuation-6h');
    base.metadata.surgeContinuation6hLastBaseEventId = 9;
    assert.equal(evaluate({ profiles: [configured], states: [base] })
      .evaluations[0].plans.some((plan) => plan.ruleKey === 'surge-continuation-6h'), false);
  });
});
