const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createSolanaAlertDestinationCoordinator,
} = require('../src/services/solana-alert-destination-coordinator');

function fixture(overrides = {}) {
  const calls = [];
  const signals = { currentVolume5m: 50_000 };
  const coordinator = createSolanaAlertDestinationCoordinator({
    async loadSignals(input) {
      calls.push(['signals', input]);
      return signals;
    },
    async evaluateDashboardProfile(input) {
      calls.push(['dashboard', input]);
      if (overrides.dashboardError) throw overrides.dashboardError;
    },
    async onDashboardError(input) {
      calls.push(['dashboard-error', input]);
    },
    async onDestinationError(input) {
      calls.push(['destination-error', input]);
    },
  });
  return { calls, coordinator, signals };
}

function input(overrides = {}) {
  return {
    dashboardProfiles: [{ userId: 7 }],
    tokenBefore: { address: '11111111111111111111111111111111' },
    tokenAfter: { address: '11111111111111111111111111111111' },
    nowMs: 123,
    alertSource: 'catalog',
    deps: {},
    summary: { errors: 0 },
    ...overrides,
  };
}

describe('Solana alert destination coordinator', () => {
  it('shares one normalized observation between dashboard and Telegram destinations', async () => {
    const { calls, coordinator, signals } = fixture();
    const telegramProfile = { destination: 'telegram', profileId: '10' };
    const destination = {
      async listSignalProfiles(context) {
        calls.push(['destination-profiles', context]);
        return [telegramProfile];
      },
      async evaluate(context) {
        calls.push(['destination', context]);
      },
    };

    const result = await coordinator.evaluate(input({ destination }));

    assert.equal(calls.filter(([name]) => name === 'signals').length, 1);
    assert.deepEqual(calls.find(([name]) => name === 'signals')[1].profiles, [
      { userId: 7 },
      telegramProfile,
    ]);
    assert.equal(calls.find(([name]) => name === 'dashboard')[1].signals, signals);
    assert.equal(calls.find(([name]) => name === 'destination')[1].signals, signals);
    assert.equal(result.signals, signals);
    assert.equal(result.dashboardEvaluated, 1);
    assert.equal(result.destinationEvaluated, true);
  });

  it('keeps dashboard evaluation running when Telegram profile discovery fails', async () => {
    const { calls, coordinator } = fixture();
    const destination = {
      async listSignalProfiles() {
        throw new Error('profile read failed');
      },
    };

    const result = await coordinator.evaluate(input({ destination }));

    assert.equal(result.dashboardEvaluated, 1);
    assert.equal(result.destinationEvaluated, false);
    assert.equal(calls.filter(([name]) => name === 'dashboard').length, 1);
    const reported = calls.find(([name]) => name === 'destination-error')[1];
    assert.equal(reported.phase, 'profile-discovery');
    assert.match(reported.error.message, /profile read failed/);
  });

  it('isolates Telegram evaluation failures after dashboard evaluation', async () => {
    const { calls, coordinator } = fixture();
    const destination = {
      async listSignalProfiles() {
        return [{ destination: 'telegram', profileId: '10' }];
      },
      async evaluate() {
        throw new Error('shadow evaluation failed');
      },
    };

    const result = await coordinator.evaluate(input({ destination }));

    assert.equal(result.dashboardEvaluated, 1);
    assert.equal(result.destinationEvaluated, false);
    assert.equal(calls.filter(([name]) => name === 'dashboard').length, 1);
    const reported = calls.find(([name]) => name === 'destination-error')[1];
    assert.equal(reported.phase, 'evaluation');
    assert.match(reported.error.message, /shadow evaluation failed/);
  });

  it('does not build market signals when no destination has profiles', async () => {
    const { calls, coordinator } = fixture();
    const result = await coordinator.evaluate(input({
      dashboardProfiles: [],
      destination: null,
    }));

    assert.equal(result.signals, null);
    assert.equal(calls.length, 0);
  });
});
