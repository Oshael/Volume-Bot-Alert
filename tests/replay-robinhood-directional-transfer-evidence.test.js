const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  applyResumePreflightPolicy, assertSchema, frozenSourceFromPlan, main, parseArgs,
  __private: { createReplayDataDatabase },
} = require('../src/utils/replay-robinhood-directional-transfer-evidence');

const HASH = `0x${'a'.repeat(64)}`;

function options(overrides = {}) {
  return {
    ...parseArgs([]), ...overrides,
  };
}

function runtime(overrides = {}) {
  return {
    providerChainIds: { 'robinhood-pc-archive': 46630 },
    repository: {
      async getRun() { return null; },
      async getTokenScopeReadiness() { return { ready: true }; },
    },
    writer: {},
    tickDeps: {
      source: { async loadBackfillPlan() { return {
        ready: true, status: 'complete', fromBlock: '100',
        live: { checkpointBlock: '999', checkpointHash: HASH },
      }; } },
      evidence: { async matchesCheckpoint() { return true; } },
    },
    ...overrides,
  };
}

describe('Robinhood directional transfer replay CLI', () => {
  it('reserves PostgreSQL capacity by bounding replay data operations', async () => {
    let active = 0;
    let maximum = 0;
    const releases = [];
    const database = createReplayDataDatabase({
      async query(value) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
        return { rows: [value] };
      },
      async getClient() { throw new Error('unexpected client'); },
    }, 2);
    const queries = [1, 2, 3, 4].map((value) => database.query(value));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 2);
    releases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 2);
    releases.splice(0).forEach((release) => release());
    assert.deepEqual((await Promise.all(queries)).map(({ rows }) => rows[0]), [1, 2, 3, 4]);
    assert.equal(maximum, 2);
  });

  it('holds a replay data permit for the full database transaction', async () => {
    let queries = 0;
    let releases = 0;
    const database = createReplayDataDatabase({
      async query() { queries += 1; return { rows: [] }; },
      async getClient() {
        return { async query() { return { rows: [] }; }, release() { releases += 1; } };
      },
    }, 1);
    const client = await database.getClient();
    const queued = database.query('SELECT 1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queries, 0);
    client.release();
    await queued;
    assert.equal(queries, 1);
    assert.equal(releases, 1);
  });

  it('parses bounded dry-run defaults and guarded retry options', () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, retryFailed: false, runId: undefined,
      rangeBlocks: 1000, concurrency: 2, sampleCount: 3, maxHours: 5,
      leaseMs: 180000, maxAttempts: 5,
    });
    assert.equal(parseArgs(['--apply', '--concurrency=4']).apply, true);
    assert.throws(() => parseArgs(['--run-id=7', '--range-blocks=50']),
      /cannot be combined/);
    assert.throws(() => parseArgs(['--retry-failed', '--run-id=7']),
      /requires --run-id and --apply/);
    assert.throws(() => parseArgs(['--max-hours=6']), /between 1 and 5/);
  });

  it('keeps canonical validation but does not reapply the full ETA cap to a resume', () => {
    assert.deepEqual(applyResumePreflightPolicy({
      approved: false, nonCanonicalRanges: 0, projectedHours: 8.4,
    }, '7'), {
      approved: true, nonCanonicalRanges: 0, projectedHours: 8.4,
      projectionCapBypassed: 'existing_campaign',
    });
    assert.equal(applyResumePreflightPolicy({
      approved: false, nonCanonicalRanges: 1, projectedHours: 8.4,
    }, '7').approved, false);
  });

  it('requires the frozen-scope publication schema before archive work', async () => {
    await assert.rejects(assertSchema({ async query() { return { rows: [{
      runs: 'runs', ranges: 'ranges', tokens: 'tokens', deployment_gaps: 'gaps',
      evidence: true, publication: false,
    }] }; } }), /159/);
  });

  it('freezes the entire durable transfer window through the live checkpoint', () => {
    assert.deepEqual(frozenSourceFromPlan({
      ready: true, status: 'complete', fromBlock: '100', throughBlock: '499',
      live: { checkpointBlock: '999', checkpointHash: HASH },
    }, 250), {
      projectionVersion: 'rh_transfer_v1',
      replayVersion: 'rh_directional_transfer_replay_v1',
      sourceFromBlock: '100', sourceThroughBlock: '999',
      sourceThroughHash: HASH, rangeBlocks: 250,
    });
    assert.throws(() => frozenSourceFromPlan({
      ready: false, reason: 'transfer_seed_running', status: 'blocked',
    }, 1000), /transfer_seed_running/);
  });

  it('runs mandatory preflight without creating a campaign in dry-run mode', async () => {
    const calls = [];
    const logger = { log() {}, error() {} };
    const result = await main([], {
      runtime: runtime(), logger,
      preflight: async ({ writer }, source) => {
        calls.push(['preflight', writer, source]);
        return { ...source, approved: true };
      },
      replay: async () => { calls.push(['replay']); },
    });
    assert.equal(result.approved, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].sourceThroughBlock, '999');
  });

  it('revalidates and resumes a frozen campaign only with explicit apply', async () => {
    const calls = [];
    const source = {
      id: '7', status: 'failed', projectionVersion: 'rh_transfer_v1',
      replayVersion: 'rh_directional_transfer_replay_v1', sourceFromBlock: '100',
      sourceThroughBlock: '999', sourceThroughHash: HASH, rangeBlocks: 250,
    };
    const existing = runtime({
      repository: {
        async getRun(id) { calls.push(['get', id]); return source; },
        async getTokenScopeReadiness(id) {
          calls.push(['readiness', id]); return { ready: true };
        },
      },
      tickDeps: {
        source: { async loadBackfillPlan() { throw new Error('unexpected plan'); } },
        evidence: { async matchesCheckpoint(checkpoint) {
          calls.push(['checkpoint', checkpoint]); return true;
        } },
      },
    });
    const result = await main([], {
      runtime: existing, logger: { log() {}, error() {} },
      options: options({ apply: true, retryFailed: true, runId: '7' }),
      preflight: async (_deps, input) => ({
        ...input, approved: false, nonCanonicalRanges: 0, projectedHours: 8.4,
      }),
      replay: async (_deps, input) => { calls.push(['replay', input]); return { status: 'completed' }; },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.map(([name]) => name),
      ['get', 'readiness', 'checkpoint', 'replay']);
    assert.equal(calls[3][1].retryFailed, true);
    assert.equal(calls[3][1].preflight.approved, true);
    assert.equal(calls[3][1].preflight.projectionCapBypassed, 'existing_campaign');
  });

  it('refuses uncovered frozen scope before probing the archive', async () => {
    const source = {
      id: '7', status: 'failed', projectionVersion: 'rh_transfer_v1',
      replayVersion: 'rh_directional_transfer_replay_v1', sourceFromBlock: '100',
      sourceThroughBlock: '999', sourceThroughHash: HASH, rangeBlocks: 250,
    };
    const invalid = runtime({ repository: {
      async getRun() { return source; },
      async getTokenScopeReadiness() { return { ready: false, unavailable: 1 }; },
    } });
    await assert.rejects(main([], {
      runtime: invalid, logger: { log() {}, error() {} },
      options: options({ runId: '7' }),
      preflight: async () => { throw new Error('unexpected preflight'); },
    }), (error) => error.code === 'directional_replay_source_unavailable'
      && error.details.unavailable === 1);
  });

  it('fails closed when the frozen target is no longer canonical', async () => {
    const invalid = runtime({
      tickDeps: {
        source: runtime().tickDeps.source,
        evidence: { async matchesCheckpoint() { return false; } },
      },
    });
    await assert.rejects(main([], {
      runtime: invalid, logger: { log() {}, error() {} },
      preflight: async () => { throw new Error('unexpected preflight'); },
    }), (error) => error.code === 'directional_replay_source_unavailable');
  });
});
