const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const userAlertRuleState = require('../src/models/user-alert-rule-state');
const {
  createRobinhoodStandardAlertPublication,
} = require('../src/services/robinhood-standard-alert-publication');

const TOKEN = `0x${'1'.repeat(40)}`;
const GENERATED_AT = '2026-07-19T18:00:30.000Z';

function signal() {
  return { id: `robinhood:${TOKEN}:101`, chain: 'robinhood', address: TOKEN, generatedAt: GENERATED_AT };
}

function candidate(overrides = {}) {
  return {
    ruleKey: 'monitored-fdv', kind: 'monitored-fdv', label: 'FDV',
    pct: 100, lastAlertedValue: 200_000, cooldownMs: 60_000,
    fingerprint: 'monitored-fdv:100000:200000', payload: { address: TOKEN, fdv: 200_000 },
    ...overrides,
  };
}

function evaluation(plans) {
  return { chain: 'robinhood', signalId: signal().id, evaluations: [{ userId: 7, plans }] };
}

function dependencies(overrides = {}) {
  const transaction = [];
  const client = {
    async query(sql) { transaction.push(sql); return { rows: [] }; },
    release() { transaction.push('RELEASE'); },
  };
  const calls = { events: 0, triggered: 0, rearmed: 0, published: 0 };
  const deps = {
    db: { getClient: async () => client },
    userAlertProfileCache: { listActiveProfiles: async () => [{ userId: 7 }] },
    userAlertRuleState: {
      listStatesByUsersForToken: async () => [],
      async markTriggered(_input, runner) { assert.equal(runner, client); calls.triggered += 1; },
      async markRearmed(_input, runner) { assert.equal(runner, client); calls.rearmed += 1; },
    },
    userAlertEvent: {
      async createEventOnce(intent, options) {
        calls.events += 1;
        assert.equal(options.db, client);
        return { id: 91, ...intent };
      },
    },
    backendAlertPublisher: {
      async publishEventSafe() {
        assert.equal(transaction.at(-1), 'RELEASE');
        calls.published += 1;
        return { notified: true };
      },
    },
    issueAuthorization: () => ({ opaque: true }),
    ...overrides,
  };
  return { calls, client, deps, transaction };
}

describe('Robinhood standard alert publication', () => {
  it('loads Robinhood rule states for users and rules in one normalized query', async () => {
    let captured;
    const runner = {
      async query(sql, params) {
        captured = { sql, params };
        return { rows: [{
          user_id: 7, rule_key: 'monitored-fdv', chain: 'robinhood', token_address: TOKEN,
          status: 'triggered', rearm_required: true, metadata: {},
        }] };
      },
    };
    const states = await userAlertRuleState.listStatesByUsersForToken({
      userIds: ['7', 7], ruleKeys: ['MONITORED-FDV'], chain: 'robinhood', tokenAddress: TOKEN,
    }, runner);
    assert.deepEqual(captured.params, [[7], ['monitored-fdv'], 'robinhood', TOKEN]);
    assert.match(captured.sql, /user_id = ANY\(\$1::bigint\[\]\)/);
    assert.equal(states[0].chain, 'robinhood');
  });

  it('evaluates shadow output without authorization, transaction or state mutation', async () => {
    const fixture = dependencies({
      evaluateSignal: () => evaluation([{ action: 'emit', ruleKey: 'monitored-fdv', candidate: candidate() }]),
      issueAuthorization: () => { throw new Error('must stay blocked'); },
      db: { getClient: async () => { throw new Error('must not transact'); } },
    });
    const publication = createRobinhoodStandardAlertPublication(fixture.deps);
    const result = await publication.consume({
      signals: [signal()], alertsRequested: true, publishable: false,
    });
    assert.equal(result.status, 'shadow');
    assert.equal(result.plannedEmits, 1);
    assert.equal(result.persisted, 0);
    assert.deepEqual(fixture.calls, { events: 0, triggered: 0, rearmed: 0, published: 0 });
  });

  it('commits event and state once, then publishes only after commit', async () => {
    const fixture = dependencies({ now: () => Date.parse('2026-07-19T18:00:30.125Z') });
    const authorization = { opaque: true };
    fixture.deps.issueAuthorization = () => authorization;
    const markTriggered = fixture.deps.userAlertRuleState.markTriggered;
    fixture.deps.userAlertRuleState.markTriggered = async (input, runner) => {
      assert.equal(input.authorization, authorization);
      return markTriggered(input, runner);
    };
    fixture.deps.evaluateSignal = () => evaluation([
      { action: 'emit', ruleKey: 'monitored-fdv', candidate: candidate(), state: null },
    ]);
    fixture.deps.userAlertEvent.createEventOnce = async (intent, options) => {
      fixture.calls.events += 1;
      assert.equal(options.authorization, authorization);
      return fixture.calls.events === 1 ? { id: 91, ...intent } : null;
    };
    const publication = createRobinhoodStandardAlertPublication(fixture.deps);
    const first = await publication.consume({
      signals: [signal()], alertsRequested: true, publishable: true,
      commitCompletedAt: '2026-07-19T18:00:30.000Z',
    });
    const replay = await publication.consume({ signals: [signal()], alertsRequested: true, publishable: true });
    assert.equal(first.persisted, 1);
    assert.equal(first.stateWrites, 1);
    assert.equal(first.commitToAlertLatencyMs, 125);
    assert.equal(replay.duplicates, 1);
    assert.equal(fixture.calls.triggered, 1);
    assert.equal(fixture.calls.published, 1);
    assert.equal(publication.getStatus().averageCommitToAlertLatencyMs, 125);
    assert.deepEqual(fixture.transaction, ['BEGIN', 'COMMIT', 'RELEASE', 'BEGIN', 'COMMIT', 'RELEASE']);
  });

  it('renders monitored repeats against the persisted anchor and coalesces hidden dedupe', async () => {
    const fixture = dependencies();
    let intent;
    let triggeredInput;
    fixture.deps.evaluateSignal = () => evaluation([{ action: 'emit', ruleKey: 'monitored-fdv',
      state: { lastAlertedValue: 100_000, metadata: {} },
      candidate: candidate({
        lastAlertedValue: 200_000, pct: 33,
        presenceMode: 'hidden', hiddenSessionKey: 'hidden:1',
        payload: { fdv: 200_000, prevFdv: 150_000 },
      }),
    }]);
    fixture.deps.userAlertEvent.createEventOnce = async (value) => {
      intent = value;
      fixture.calls.events += 1;
      return { id: 92, ...value };
    };
    fixture.deps.userAlertRuleState.markTriggered = async (value) => {
      triggeredInput = value;
      fixture.calls.triggered += 1;
    };
    const publication = createRobinhoodStandardAlertPublication(fixture.deps);
    await publication.consume({ signals: [signal()], alertsRequested: true, publishable: true });
    assert.equal(intent.dedupeKey, `7:monitored-fdv:${TOKEN}:hidden`);
    assert.equal(intent.payload.prevFdv, 100_000);
    assert.equal(intent.payload.pct, 100);
    assert.equal(triggeredInput.metadata.lastPresenceMode, 'hidden');
    assert.equal(triggeredInput.metadata.lastHiddenSessionKey, 'hidden:1');
  });

  it('applies prime and rearm plans atomically without manufacturing events', async () => {
    let primedInput;
    const fixture = dependencies({
      evaluateSignal: () => evaluation([
        { action: 'prime', ruleKey: 'old-week-surge-1h', candidate: candidate({
          ruleKey: 'old-week-surge-1h', kind: 'old-surge', fingerprint: 'surge:prime',
          sessionStartedAt: '2026-07-19T18:00:00.000Z',
          payload: { fdv: 200_000, ageBucket: 'old-week', surgeWindow: '1H', thresholdPct: 50 },
        }), state: null },
        { action: 'rearm', ruleKey: 'monitored-vol', candidate: null,
          state: { status: 'triggered', cooldownUntil: '2026-07-19T18:01:00.000Z' } },
      ]),
    });
    fixture.deps.userAlertRuleState.markTriggered = async (input) => {
      primedInput = input;
      fixture.calls.triggered += 1;
    };
    const publication = createRobinhoodStandardAlertPublication(fixture.deps);
    const result = await publication.consume({ signals: [signal()], alertsRequested: true, publishable: true });
    assert.equal(result.stateWrites, 2);
    assert.equal(result.persisted, 0);
    assert.equal(fixture.calls.triggered, 1);
    assert.equal(fixture.calls.rearmed, 1);
    assert.equal(fixture.calls.events, 0);
    assert.equal(primedInput.metadata.sessionStartedAt, '2026-07-19T18:00:00.000Z');
    assert.equal(primedInput.metadata.thresholdPct, 50);
    assert.deepEqual(fixture.transaction, ['BEGIN', 'COMMIT', 'RELEASE']);
  });

  it('records a continuation event on its base 6h state', async () => {
    const fixture = dependencies();
    let rearmInput;
    fixture.deps.userAlertRuleState.markRearmed = async (input) => {
      rearmInput = input;
      fixture.calls.rearmed += 1;
    };
    fixture.deps.userAlertEvent.createEventOnce = async (intent) => {
      fixture.calls.events += 1;
      return fixture.calls.events === 1 ? { id: 93, ...intent } : null;
    };
    fixture.deps.evaluateSignal = () => evaluation([{ action: 'emit',
      ruleKey: 'surge-continuation-6h', state: { metadata: { lastEventId: 9 } },
      candidate: candidate({
        ruleKey: 'surge-continuation-6h', kind: 'old-surge', fingerprint: 'base:9:3x',
        label: 'SURGE CONTINUATION 6H', pct: 250,
        payload: {
          fdv: 300_000, surgeContinuationBaseRuleKey: 'old-week-surge-6h',
          surgeContinuationBaseEventId: 9, surgeContinuationMultiplier: 3,
        },
      }),
    }]);
    const publication = createRobinhoodStandardAlertPublication(fixture.deps);
    const first = await publication.consume({ signals: [signal()], alertsRequested: true, publishable: true });
    const replay = await publication.consume({ signals: [signal()], alertsRequested: true, publishable: true });
    assert.equal(first.persisted, 1);
    assert.equal(replay.duplicates, 1);
    assert.equal(rearmInput.ruleKey, 'old-week-surge-6h');
    assert.equal(rearmInput.metadata.surgeContinuation6hLastBaseEventId, 9);
    assert.equal(rearmInput.metadata.surgeContinuation6hFdv, 300_000);
    assert.equal(rearmInput.metadata.surgeContinuation6hMultiplier, 3);
    assert.equal(fixture.calls.rearmed, 1);
    assert.equal(fixture.calls.published, 1);
  });

  it('rolls back the event when its state transition fails and never publishes it', async () => {
    const fixture = dependencies({
      evaluateSignal: () => evaluation([
        { action: 'emit', ruleKey: 'monitored-fdv', candidate: candidate(), state: null },
      ]),
    });
    fixture.deps.userAlertRuleState.markTriggered = async () => { throw new Error('state failed'); };
    const publication = createRobinhoodStandardAlertPublication(fixture.deps);
    await assert.rejects(
      () => publication.consume({ signals: [signal()], alertsRequested: true, publishable: true }),
      /state failed/,
    );
    assert.deepEqual(fixture.transaction, ['BEGIN', 'ROLLBACK', 'RELEASE']);
    assert.equal(fixture.calls.published, 0);
    assert.equal(publication.getStatus().errors, 1);
    assert.equal(publication.getStatus().lastStatus, 'error');
  });
});
