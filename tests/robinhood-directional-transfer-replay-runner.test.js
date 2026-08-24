const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  executeReplay, plan, runPreflight,
} = require('../src/services/robinhood-directional-transfer-replay-runner');

const HASH = `0x${'a'.repeat(64)}`;
const SOURCE = {
  projectionVersion: 'rh_transfer_v1', replayVersion: 'rh_directional_transfer_replay_v1',
  sourceFromBlock: '100', sourceThroughBlock: '499', sourceThroughHash: HASH,
  rangeBlocks: 100,
};

describe('Robinhood directional transfer replay runner', () => {
  it('samples the frozen block window and projects a conservative ETA', async () => {
    assert.deepEqual(plan({ ...SOURCE, sampleCount: 2 }).samples, [
      { rangeStartBlock: '100', rangeEndBlock: '199' },
      { rangeStartBlock: '400', rangeEndBlock: '499' },
    ]);
    const times = [0, 100, 100, 300];
    const result = await runPreflight({
      now: () => times.shift(),
      writer: { async probeRange() {
        return {
          checkpointCanonical: true, rpcRequests: 2,
          transfersScanned: 10, edgesConsidered: 4,
        };
      } },
    }, { ...SOURCE, sampleCount: 2, concurrency: 2 });
    assert.equal(result.averageSampleMs, 150);
    assert.equal(result.projectedMs, 375);
    assert.equal(result.nonCanonicalRanges, 0);
    assert.deepEqual(
      [result.sampleRpcRequests, result.sampleTransfersScanned, result.sampleEdgesConsidered],
      [4, 20, 8]
    );
    assert.equal(result.approved, true);
  });

  it('refuses non-canonical samples and projections above five hours', async () => {
    const nonCanonical = await runPreflight({
      now: (() => { let value = 0; return () => { value += 10; return value; }; })(),
      writer: { async probeRange() { return { checkpointCanonical: false }; } },
    }, { ...SOURCE, sampleCount: 1 });
    await assert.rejects(executeReplay({}, { preflight: nonCanonical }),
      (error) => error.code === 'directional_replay_preflight_refused');

    const tooSlow = await runPreflight({
      now: (() => { const values = [0, 18_000_000]; return () => values.shift(); })(),
      writer: { async probeRange() { return { checkpointCanonical: true }; } },
    }, { ...SOURCE, sampleCount: 1, concurrency: 1 });
    assert.equal(tooSlow.projectedHours, 25);
    assert.equal(tooSlow.approved, false);
    assert.throws(() => plan({ ...SOURCE, rangeBlocks: 5001 }), /between 1 and 5000/);
  });

  it('creates and drains an approved checkpointed campaign', async () => {
    let claimed = false;
    let completed = false;
    const calls = [];
    const repository = {
      async createRun(input) { calls.push(['create', input]); return { id: '7', status: 'planned' }; },
      async ensureTokenScope(id) { calls.push(['scope', id]); },
      async startRun(id) { calls.push(['start', id]); },
      async reclaimExpired(id) { calls.push(['reclaim', id]); return 0; },
      async claimRange() {
        if (claimed) return null;
        claimed = true;
        return { id: '8', rangeStartBlock: '100', rangeEndBlock: '199', attemptCount: 1 };
      },
      async completeRange(input) { completed = true; calls.push(['complete', input]); },
      async retryRange() { throw new Error('unexpected retry'); },
      async getProgress() {
        return { status: completed ? 'completed' : 'running', total: 1,
          completed: completed ? 1 : 0, progressPct: completed ? 100 : 0 };
      },
    };
    const preflight = { ...SOURCE, approved: true, concurrency: 1 };
    const result = await executeReplay({
      repository,
      writer: { async materializeRange(range) { return {
        completedThroughBlock: range.rangeEndBlock, completedThroughHash: HASH,
        blocksScanned: 100, transfersScanned: 10, edgesConsidered: 4, edgesWritten: 3,
      }; } },
    }, { preflight });
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, '7');
    assert.deepEqual(calls.map(([name]) => name),
      ['create', 'scope', 'start', 'reclaim', 'complete']);
    assert.equal(calls[4][1].completedThroughBlock, '199');
  });

  it('resumes only an explicit failed campaign with the same frozen source', async () => {
    const calls = [];
    const repository = {
      async getRun() { return { id: '7', status: 'failed', ...SOURCE }; },
      async ensureTokenScope(id) { calls.push(['scope', id]); },
      async resumeFailed(id) { calls.push(['resume', id]); return { runId: id, requeued: 2 }; },
      async reclaimExpired(id) { calls.push(['reclaim', id]); return 0; },
      async claimRange() { return null; },
      async getProgress() { return { status: 'completed', total: 2, completed: 2 }; },
    };
    const result = await executeReplay({
      repository, writer: { async materializeRange() {} },
    }, {
      preflight: { ...SOURCE, approved: true, concurrency: 1 },
      runId: '7', retryFailed: true, onRun(value) { calls.push(['run', value]); },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, [
      ['scope', '7'],
      ['resume', '7'],
      ['run', { runId: '7', status: 'running', requeued: 2 }],
      ['reclaim', '7'],
    ]);
    await assert.rejects(executeReplay({
      repository: { async getRun() { return {
        id: '8', status: 'failed', ...SOURCE, sourceThroughBlock: '500',
      }; } },
      writer: { async materializeRange() {} },
    }, {
      preflight: { ...SOURCE, approved: true, concurrency: 1 },
      runId: '8', retryFailed: true,
    }), /does not match the frozen/);
  });

  it('collects missing-edge tokens and drains later ranges before settling', async () => {
    const token = `0x${'1'.repeat(40)}`;
    const calls = [];
    let claimCount = 0;
    let settled = false;
    const repository = {
      async createRun() { return { id: '9', status: 'planned' }; },
      async ensureTokenScope() {}, async startRun() {}, async reclaimExpired() {},
      async claimRange() {
        claimCount += 1;
        if (claimCount === 1) {
          return { id: '10', rangeStartBlock: '100', rangeEndBlock: '199', attemptCount: 1 };
        }
        if (claimCount === 2) {
          return { id: '11', rangeStartBlock: '200', rangeEndBlock: '299', attemptCount: 1 };
        }
        return null;
      },
      async stageTokenRepairCandidates(input) {
        calls.push(['stage', input]); return { unresolved: 1 };
      },
      async deferRangeForTokenRepair(input) {
        calls.push(['defer', input.rangeId, input.error.code]);
      },
      async completeRange(input) { calls.push(['complete', input.rangeId]); },
      async retryRange() { throw new Error('unexpected retry'); },
      async settleTokenRepairDiscovery(id) {
        calls.push(['settle', id]); settled = true;
      },
      async getProgress() {
        return settled
          ? { status: 'failed', total: 2, completed: 1, failed: 1, pending: 0, leased: 0 }
          : { status: 'running', total: 2, completed: 1, failed: 1, pending: 0, leased: 0 };
      },
    };
    const error = Object.assign(new Error('missing edge'), {
      code: 'directional_replay_edge_missing', tokenAddresses: [token],
    });
    await executeReplay({
      repository, writer: { async materializeRange(range) {
        if (range.id === '10') throw error;
        return {
          completedThroughBlock: range.rangeEndBlock, completedThroughHash: HASH,
          blocksScanned: 100, transfersScanned: 10, edgesConsidered: 4, edgesWritten: 3,
        };
      } },
    }, { preflight: { ...SOURCE, approved: true, concurrency: 1 } });
    assert.deepEqual(calls, [
      ['stage', { runId: '9', rangeId: '10', tokenAddresses: [token] }],
      ['defer', '10', 'directional_repair_deployment_unavailable'],
      ['complete', '11'],
      ['settle', '9'],
    ]);
  });
});
