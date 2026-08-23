const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  frozenSourceFromPlan, main, parseArgs,
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
    repository: { async getRun() { return null; } },
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
      repository: { async getRun(id) { calls.push(['get', id]); return source; } },
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
      preflight: async (_deps, input) => ({ ...input, approved: true }),
      replay: async (_deps, input) => { calls.push(['replay', input]); return { status: 'completed' }; },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'checkpoint', 'replay']);
    assert.equal(calls[2][1].retryFailed, true);
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
