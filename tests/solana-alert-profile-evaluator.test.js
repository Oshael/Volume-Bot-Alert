const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createSolanaAlertProfileEvaluator,
} = require('../src/services/solana-alert-profile-evaluator');

function fixture() {
  const calls = [];
  const candidates = [{ ruleKey: 'monitored-vol' }];
  const ports = {
    buildRuleDecision(input) {
      calls.push(['decision', input]);
      return {
        candidates,
        qualifiedRuleKeys: ['monitored-vol'],
      };
    },
    buildRearmRuleKeys(input) {
      calls.push(['rearm', input]);
      return ['monitored-mcap'];
    },
    async evaluateLifecycle(input) {
      calls.push(['lifecycle', input]);
      input.summary.emitted += 1;
    },
    async evaluateContinuation(input) {
      calls.push(['continuation', input]);
      input.summary.continuations += 1;
    },
  };
  return { calls, candidates, ports };
}

describe('Solana alert profile evaluator boundary', () => {
  it('evaluates one normalized observation through explicit rule and persistence ports', async () => {
    const { calls, candidates, ports } = fixture();
    const evaluator = createSolanaAlertProfileEvaluator(ports);
    const profile = { userId: 7 };
    const tokenAfter = { address: '11111111111111111111111111111111' };
    const signals = { currentVolume5m: 20_000 };
    const deps = { state: {} };
    const summary = { emitted: 0, continuations: 0 };

    const result = await evaluator.evaluate({
      profile,
      tokenAfter,
      signals,
      deps,
      summary,
      nowMs: 123,
    });

    assert.equal(summary.emitted, 1);
    assert.equal(summary.continuations, 1);
    assert.deepEqual(result.candidates, candidates);
    assert.deepEqual(result.qualifiedRuleKeys, ['monitored-vol']);
    assert.deepEqual(result.rearmRuleKeys, ['monitored-mcap']);
    assert.equal(calls[0][1].profile, profile);
    assert.equal(calls[0][1].signals, signals);
    assert.deepEqual(calls[1][1], {
      profile,
      qualifiedRuleKeys: ['monitored-vol'],
    });
    assert.equal(calls[2][1].deps, deps);
    assert.equal(calls[2][1].summary, summary);
    assert.equal(calls[3][1].tokenAfter, tokenAfter);
  });

  it('rejects incomplete ports and malformed observations before evaluation', async () => {
    assert.throws(
      () => createSolanaAlertProfileEvaluator({}),
      /port is required: buildRuleDecision/
    );

    const { calls, ports } = fixture();
    const evaluator = createSolanaAlertProfileEvaluator(ports);
    await assert.rejects(
      () => evaluator.evaluate({
        profile: { userId: 7 },
        tokenAfter: {},
        signals: {},
        deps: {},
        summary: {},
        nowMs: 123,
      }),
      /tokenAfter\.address is required/
    );
    assert.equal(calls.length, 0);
  });

  it('propagates destination failures so the caller can isolate them per profile', async () => {
    const { ports } = fixture();
    ports.evaluateLifecycle = async () => {
      throw new Error('state write failed');
    };
    const evaluator = createSolanaAlertProfileEvaluator(ports);

    await assert.rejects(
      () => evaluator.evaluate({
        profile: { userId: 7 },
        tokenAfter: { address: '11111111111111111111111111111111' },
        signals: {},
        deps: {},
        summary: {},
        nowMs: 123,
      }),
      /state write failed/
    );
  });
});
