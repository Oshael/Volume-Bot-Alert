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
    volumeWindows: {
      '1h': { usd: 1200, coverage: 'complete' },
      '6h': { usd: 3400, coverage: 'complete' },
      '24h': { usd: 5600, coverage: 'complete' },
    },
    valuation: {
      type: 'fdv', current: { fdvUsd: 200_000, priceUsd: 2 },
      windows: {
        '5m': { fdvUsd: 100_000, fdvChangePct: 100, coverage: 'complete' },
        '1h': { fdvUsd: 100_000, priceChangePct: 100,
          previousPriceChangePct: 90, coverage: 'complete' },
        '6h': { fdvUsd: 50_000, priceChangePct: 300,
          previousPriceChangePct: 200, coverage: 'complete' },
      },
    },
    tokenAge: {
      createdAt: '2026-07-09T18:00:30.000Z',
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
  it('does not build standard alerts at the global FDV cap', () => {
    const capped = signal({
      valuation: {
        ...signal().valuation,
        current: { fdvUsd: 30_000_000_000, priceUsd: 2 },
      },
    });
    const result = evaluate({
      signal: capped,
      profiles: [profile(1, { ruleEnabled: { monitoredVol: true, oldWeekSurge1h: true } })],
    });

    assert.deepEqual(result.evaluations[0].candidates, []);
    assert.equal(result.evaluations[0].plans.some((plan) => plan.action === 'emit'), false);
  });

  it('evaluates volume thresholds independently per user', () => {
    const result = evaluate({ profiles: [
      profile(1, { ruleEnabled: { monitoredVol: true }, thresholdPct: 100 }),
      profile(2, { ruleEnabled: { monitoredVol: true }, thresholdPct: 250 }),
    ] });
    assert.equal(result.evaluations[0].plans[0].action, 'emit');
    assert.equal(result.evaluations[0].plans[0].ruleKey, 'monitored-vol');
    assert.deepEqual(result.evaluations[0].plans[0].candidate.payload, {
      address: TOKEN, valuationType: 'fdv', fdv: 200_000,
      volume5m: 300, volume1h: 1200, volume6h: 3400, volume24h: 5600,
      tokenAgeMs: 10 * 24 * 60 * 60 * 1000,
      tokenCreatedAt: Date.parse('2026-07-09T18:00:30.000Z'), prevVolume5m: 100,
    });
    assert.equal(result.evaluations[1].plans.length, 0);
  });

  it('filters disabled chains and applies Robinhood-scoped standard settings', () => {
    const result = evaluate({ profiles: [
      profile(1, {
        enabledChains: ['solana'],
        ruleEnabled: { monitoredVol: true },
        thresholdPct: 100,
      }),
      profile(2, {
        enabledChains: ['robinhood'],
        ruleEnabled: { monitoredVol: false },
        thresholdPct: 500,
        alertConfigByChain: {
          robinhood: {
            ruleEnabled: { monitoredVol: true },
            thresholdPct: 100,
            minVol: 100,
            minFdv: 30_000,
            maxFdv: 0,
          },
        },
      }),
    ] });

    assert.deepEqual(result.evaluations.map((evaluation) => evaluation.userId), [2]);
    assert.equal(result.evaluations[0].plans[0].ruleKey, 'monitored-vol');
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
    const configured = profile(1, {
      loadedAt: '2026-07-19T18:00:00.000Z', ruleEnabled: { oldWeekSurge1h: true },
    });
    const first = evaluate({ profiles: [configured] });
    assert.equal(first.evaluations[0].plans[0].action, 'prime');
    const primed = {
      userId: 1, ruleKey: 'old-week-surge-1h', status: 'triggered', rearmRequired: true,
      lastAlertedAt: null, lastAlertedPct: 100,
      metadata: { lastDecision: 'primed-hot', sessionStartedAt: configured.loadedAt },
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
  it('requires a fresh 6h crossing after cooldown but accepts an expired cold reset', () => {
    const configured = profile(1, { ruleEnabled: { oldWeekSurge6h: true } });
    const state = {
      userId: 1, ruleKey: 'old-week-surge-6h', status: 'rearmed', rearmRequired: false,
      lastAlertedAt: '2026-07-19T10:00:00.000Z', lastAlertedPct: 200,
      metadata: { lastAlertedFdv: 100_000 },
    };
    assert.equal(evaluate({ profiles: [configured], states: [state] })
      .evaluations[0].plans[0].action, 'suppress');
    const crossed = signal({ valuation: { ...signal().valuation, windows: {
      ...signal().valuation.windows,
      '6h': { ...signal().valuation.windows['6h'], previousPriceChangePct: 90 },
    } } });
    assert.equal(evaluate({ signal: crossed, profiles: [configured], states: [state] })
      .evaluations[0].plans[0].action, 'emit');
    state.metadata.surgeResetPchangeSinceAt = '2026-07-19T15:59:00.000Z';
    assert.equal(evaluate({ profiles: [configured], states: [state] })
      .evaluations[0].plans[0].action, 'emit');
  });
  it('expires the monitored volume anchor after 30 cold minutes', () => {
    const state = {
      userId: 1, ruleKey: 'monitored-vol', status: 'rearmed', rearmRequired: false,
      lastAlertedValue: 1_000,
      metadata: { monitoredVolColdSinceAt: '2026-07-19T17:30:00.000Z' },
    };
    const result = evaluate({
      profiles: [profile(1, { ruleEnabled: { monitoredVol: true } })], states: [state],
    });
    assert.equal(result.evaluations[0].plans[0].action, 'emit');
    assert.equal(result.evaluations[0].plans[0].state, null);
  });
  it('tracks surge drawdown reset state against FDV', () => {
    const state = {
      userId: 1, ruleKey: 'old-week-surge-1h', status: 'rearmed', rearmRequired: false,
      lastAlertedAt: '2026-07-19T17:00:00.000Z', lastAlertedPct: 100,
      metadata: { lastAlertedFdv: 100_000, surgePostAlertHighFdv: 400_000 },
    };
    const result = evaluate({
      profiles: [profile(1, { ruleEnabled: { oldWeekSurge1h: true } })], states: [state],
    });
    const sync = result.evaluations[0].plans.find((plan) => plan.action === 'rearm');
    assert.equal(result.evaluations[0].plans[0].action, 'suppress');
    assert.equal(sync.state.metadata.surgeResetDrawdownSinceAt, NOW);
    assert.equal(sync.state.metadata.surgePostAlertHighFdv, 400_000);
  });
  it('does not carry a primed surge anchor into a later active session', () => {
    const configured = profile(1, {
      loadedAt: '2026-07-19T17:00:00.000Z', ruleEnabled: { oldWeekSurge1h: true },
    });
    const stalePrime = {
      userId: 1, ruleKey: 'old-week-surge-1h', status: 'triggered', rearmRequired: true,
      lastAlertedAt: null, lastAlertedPct: 100,
      metadata: { lastDecision: 'primed-hot', sessionStartedAt: '2026-07-19T16:00:00.000Z' },
    };
    const result = evaluate({ profiles: [configured], states: [stalePrime] });
    assert.equal(result.evaluations[0].plans[0].action, 'emit');
    assert.equal(result.evaluations[0].plans[0].state, null);
  });
  it('suppresses repeats while the user remains in hidden presence', () => {
    const configured = profile(1, {
      presenceMode: 'hidden', hiddenSessionKey: 'hidden:1',
      ruleEnabled: { monitoredFdv: true },
    });
    const state = {
      userId: 1, ruleKey: 'monitored-fdv', status: 'rearmed', rearmRequired: false,
      lastAlertedAt: '2026-07-19T17:00:00.000Z', lastAlertedValue: 100_000,
      metadata: { lastPresenceMode: 'hidden', lastHiddenSessionKey: 'hidden:1' },
    };
    const hidden = evaluate({ profiles: [configured], states: [state] });
    assert.equal(hidden.evaluations[0].plans[0].action, 'suppress');
    state.metadata.lastPresenceMode = 'foreground';
    const foregroundAnchor = evaluate({ profiles: [configured], states: [state] });
    assert.equal(foregroundAnchor.evaluations[0].plans[0].action, 'emit');
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
    const idle = { ...state, status: 'idle', rearmRequired: false, metadata: {} };
    const idleResult = evaluate({
      signal: blocked, profiles: [profile(1, { ruleEnabled: { monitoredVol: true } })], states: [idle],
    });
    assert.equal(idleResult.evaluations[0].plans.length, 0);
  });
  it('plans the existing 3x continuation once per base 6h surge event', () => {
    const configured = profile(1, { ruleEnabled: { oldWeekSurge6h: true } });
    const base = { userId: 1, ruleKey: 'old-week-surge-6h', lastAlertedAt: '2026-07-19T16:00:00Z',
      metadata: { lastAlertedFdv: 50_000, lastEventId: 9 } };
    const result = evaluate({ profiles: [configured], states: [base] });
    const continuation = result.evaluations[0].plans.at(-1);
    assert.equal(continuation.ruleKey, 'surge-continuation-6h');
    assert.equal(continuation.candidate.label, 'SURGE CONTINUATION 6H');
    assert.equal(continuation.candidate.pct, 300);
    assert.equal(continuation.candidate.payload.prevFdv, 50_000);
    assert.equal(continuation.candidate.payload.surgeContinuationBaseEventId, 9);
    assert.equal(continuation.candidate.payload.surgeContinuationMultiplier, 4);
    base.metadata.surgeContinuation6hLastBaseEventId = 9;
    assert.equal(evaluate({ profiles: [configured], states: [base] })
      .evaluations[0].plans.some((plan) => plan.ruleKey === 'surge-continuation-6h'), false);
  });
});
