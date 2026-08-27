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

  it('runs and resumes a complete campaign only from successful page checkpoints', async () => {
    const progress = [];
    const source = {
      async countSeedTokens() { return 3; },
      async listSeedTokens({ afterToken }) { return afterToken ? [C] : [A, B]; },
      async loadSeedToken({ tokenAddress }) { return { ready: true, tokenAddress }; },
    };
    const runner = createRobinhoodPossibleBundleRunner({
      source,
      materialize: ({ tokenAddress }) => ({ token: tokenAddress,
        groups: [{}], members: [{}, {}] }),
      snapshots: { async replaceSnapshot() { return { status: 'published' }; } },
    });
    const first = await runner.runCampaign({ runId: 1, minimumValueWei: '10',
      limit: 2, concurrency: 1, maxPages: 1,
      onProgress: (value) => progress.push(value) });
    assert.equal(first.pages, 1);
    assert.equal(first.completed, 2);
    assert.equal(first.nextToken, B);
    assert.equal(first.exhausted, false);
    const resumed = await runner.runCampaign({ runId: 1, minimumValueWei: '10',
      limit: 2, concurrency: 1, maxPages: 5, resume: first });
    assert.equal(progress.length, 1);
    assert.equal(resumed.pages, 2);
    assert.equal(resumed.completed, 3);
    assert.equal(resumed.groups, 3);
    assert.equal(resumed.members, 6);
    assert.equal(resumed.progressBps, 10_000);
    assert.equal(resumed.exhausted, true);
    await assert.rejects(runner.runCampaign({ runId: 1, minimumValueWei: '11',
      limit: 2, concurrency: 1, maxPages: 5, resume: first }), /checkpoint does not match/);
  });

  it('does not advance a campaign cursor across a blocked page', async () => {
    const progress = [];
    const runner = createRobinhoodPossibleBundleRunner({
      source: {
        async countSeedTokens() { return 2; },
        async listSeedTokens() { return [A, B]; },
        async loadSeedToken({ tokenAddress }) {
          return tokenAddress === B ? { ready: false, reason: 'missing evidence' }
            : { ready: true, tokenAddress };
        },
      },
      materialize: ({ tokenAddress }) => ({ token: tokenAddress, groups: [], members: [] }),
      snapshots: { async replaceSnapshot() { return { status: 'published' }; } },
    });
    const report = await runner.runCampaign({ runId: 1, minimumValueWei: '10',
      limit: 2, concurrency: 2, maxPages: 2,
      onProgress: (value) => progress.push(value) });
    assert.equal(report.blocked, true);
    assert.equal(report.pages, 0);
    assert.equal(report.candidates, 0);
    assert.equal(report.nextToken, null);
    assert.equal(report.retryAfterToken, null);
    assert.deepEqual(report.deferredTokens,
      [{ tokenAddress: B, reason: 'missing evidence' }]);
    assert.equal(progress.length, 0);
  });
});

describe('Robinhood possible-bundle shadow command', () => {
  it('accepts central database variants and is read-only by default', async () => {
    assert.throws(() => parseArgs([]), /run-id is required/);
    assert.throws(() => parseArgs(['--run-id=1']), /minimum-value-wei must be positive/);
    assert.throws(() => parseArgs([
      '--run-id=1', '--minimum-value-wei=10', '--max-pages=2',
    ]), /requires --apply/);
    assert.throws(() => parseArgs([
      '--run-id=1', '--minimum-value-wei=10', '--max-pages=2', '--apply',
    ]), /checkpoint-file is required/);
    const options = parseArgs(['--run-id=1', '--minimum-value-wei=10']);
    assert.equal(options.apply, false);
    let ran = false;
    const report = await main([], {
      options, env: { POSTGRES_URL: 'postgres://test' }, logger: { log() {} },
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
      options, env: { DB_HOST: 'test' }, logger: { log() {} },
      runner: { async runPage(input) { received = input; return expected; } },
    });
    assert.equal(report, expected);
    assert.equal(received.apply, true);
    assert.equal(received.minimumValueWei, '10');
  });

  it('persists progress while applying a resumable campaign', async () => {
    const options = parseArgs([
      '--run-id=1', '--minimum-value-wei=10', '--limit=100', '--concurrency=4',
      '--max-pages=100', '--checkpoint-file=/tmp/possible-bundle-shadow-test.json',
      '--apply',
    ]);
    const writes = [];
    let received;
    const expected = { mode: 'shadow', blocked: false, exhausted: true };
    const report = await main([], {
      options, logger: { log() {}, error() {} }, readCheckpoint: () => ({ pages: 1 }),
      writeCheckpoint: (_, value) => writes.push(value),
      runner: { async runCampaign(input) {
        received = input;
        await input.onProgress({ pages: 2, completed: 200, totalCandidateTokens: 300,
          progressBps: 6666, elapsedMs: 10, estimatedRemainingMs: 5 });
        return expected;
      } },
    });
    assert.equal(report, expected);
    assert.deepEqual(received.resume, { pages: 1 });
    assert.equal(received.minimumValueWei, '10');
    assert.deepEqual(writes, [
      { pages: 2, completed: 200, totalCandidateTokens: 300,
        progressBps: 6666, elapsedMs: 10, estimatedRemainingMs: 5 },
      expected,
    ]);
  });
});
