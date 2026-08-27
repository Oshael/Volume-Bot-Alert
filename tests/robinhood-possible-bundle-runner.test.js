const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodPossibleBundleRunner } = require(
  '../src/services/robinhood-possible-bundle-runner'
);
const { main, parseArgs } = require(
  '../src/utils/materialize-robinhood-possible-bundles'
);

const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const C = `0x${'3'.repeat(40)}`;

describe('Robinhood possible-bundle shadow runner', () => {
  it('materializes a bounded page and contains token failures', async () => {
    const calls = [];
    const runner = createRobinhoodPossibleBundleRunner({
      source: {
        async listSeedTokens(input) { calls.push(['list', input]); return [A, B, C]; },
        async loadSeedToken({ tokenAddress }) {
          calls.push(['load', tokenAddress]);
          return tokenAddress === B ? { ready: false } : { ready: true, tokenAddress };
        },
      },
      materialize(input) {
        calls.push(['materialize', input.tokenAddress, input.minimumValueWei]);
        return { token: input.tokenAddress, groups: [{}], members: [{}, {}] };
      },
      snapshots: { async replaceSnapshot(snapshot) {
        if (snapshot.token === C) throw new Error('broken token');
        return { status: 'published' };
      } },
    });
    assert.deepEqual(await runner.runPage({
      runId: 1, minimumValueWei: '10', limit: 3, concurrency: 2, afterToken: A,
    }), {
      mode: 'shadow', runId: '1', minimumValueWei: '10', candidates: 3,
      completed: 1, deferred: 1, failed: 1, groups: 1, members: 2,
      deferredTokens: [{ tokenAddress: B, reason: 'unknown' }],
      failedTokens: [{ tokenAddress: C, error: 'broken token' }],
      pageAfterToken: A, pageEndToken: C, blocked: true,
      nextToken: null, exhausted: false,
    });
    assert.deepEqual(calls[0], ['list', { runId: '1', afterToken: A, limit: 3 }]);
    assert.ok(calls.some((item) => item[0] === 'materialize' && item[2] === '10'));
  });

  it('requires explicit positive policy and bounded concurrency', async () => {
    const runner = createRobinhoodPossibleBundleRunner({
      source: { listSeedTokens: async () => [], loadSeedToken: async () => ({}) },
      snapshots: { replaceSnapshot: async () => ({}) },
    });
    await assert.rejects(runner.runPage({ runId: 1 }), /minimumValueWei/);
    await assert.rejects(runner.runPage({
      runId: 1, minimumValueWei: '1', concurrency: 5,
    }), /concurrency/);
  });
});

describe('Robinhood possible-bundle shadow command', () => {
  it('is read-only by default and requires explicit run and threshold', async () => {
    assert.throws(() => parseArgs([]), /run-id is required/);
    assert.throws(() => parseArgs(['--run-id=1']), /minimum-value-wei must be positive/);
    const options = parseArgs(['--run-id=1', '--minimum-value-wei=10']);
    assert.equal(options.apply, false);
    let ran = false;
    const report = await main([], {
      options, env: { DATABASE_URL: 'postgres://test' }, logger: { log() {} },
      source: { async listSeedTokens() { return [A, B]; } },
      runner: { async runPage() { ran = true; } },
    });
    assert.equal(ran, false);
    assert.deepEqual(report, { mode: 'read-only', runId: '1', minimumValueWei: '10',
      pageCandidates: 2, pageAfterToken: null, nextToken: B, exhausted: true });
  });

  it('writes only with apply and forwards the frozen policy', async () => {
    const options = parseArgs([
      '--run-id=1', '--minimum-value-wei=10', '--limit=3', '--concurrency=2', '--apply',
    ]);
    let received;
    const expected = { mode: 'shadow', completed: 3 };
    const report = await main([], {
      options, env: { DATABASE_URL: 'postgres://test' }, logger: { log() {} },
      runner: { async runPage(input) { received = input; return expected; } },
    });
    assert.equal(report, expected);
    assert.equal(received.apply, true);
    assert.equal(received.minimumValueWei, '10');
  });
});
