const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { executeBundleFundingBackfill } = require(
  '../src/services/robinhood-bundle-funding-backfill-runner'
);
const { main, parseArgs } = require('../src/utils/backfill-robinhood-bundle-funding');

const HASH = `0x${'a'.repeat(64)}`;
function run(status = 'running') {
  return { id: '7', status, sourceThroughBlock: '20', sourceThroughHash: HASH,
    lookbackBlocks: '1000', batchBlocks: 50, concurrency: 1 };
}

describe('Robinhood bundle funding backfill runner', () => {
  it('renews the lease and atomically completes claimed materialization', async () => {
    const calls = [];
    let claimed = false;
    let complete = false;
    const repository = {
      async createRun() { return run(); },
      async reclaimExpired(id) { calls.push(['reclaim', id]); return 0; },
      async claimRange(input) {
        if (claimed) return null;
        claimed = true;
        calls.push(['claim', input.runId]);
        return { rangeIndex: 0, fromBlock: '10', throughBlock: '20', attemptCount: 1,
          candidates: [{}] };
      },
      async renewRangeLease(input) { calls.push(['renew', input.rangeIndex]); },
      async completeRange(input) { complete = true; calls.push(['complete', input.rawEvents.length]); },
      async retryRange() { throw new Error('unexpected retry'); },
      async getProgress() { return { status: complete ? 'completed' : 'running',
        total: 1, pending: 0, leased: complete ? 0 : 1,
        completed: complete ? 1 : 0, failed: 0 }; },
    };
    const result = await executeBundleFundingBackfill({ repository,
      reader: { async assertChain() { return '4663'; }, async checkpoint() { return HASH; } },
      heartbeatMs: 2,
      async materialize() {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return { completedThroughHash: HASH, nativeTransfersScanned: 3,
          rawEvents: [{}], edges: [{}] };
      },
    }, { plan: {}, preflight: { approved: true }, maxMinutes: 1 });
    assert.equal(result.status, 'completed');
    assert.ok(calls.some(([name]) => name === 'renew'));
    assert.deepEqual(calls.find(([name]) => name === 'complete'), ['complete', 1]);
  });

  it('resumes only an explicit failed run and verifies its frozen checkpoint', async () => {
    let resumed = false;
    const repository = {
      async getRun() { return run('failed'); },
      async resumeFailed() { resumed = true; return { requeued: 2 }; },
      async reclaimExpired() { return 0; }, async claimRange() { return null; },
      async getProgress() { return { status: 'completed', total: 2, pending: 0,
        leased: 0, completed: 2, failed: 0 }; },
    };
    const result = await executeBundleFundingBackfill({ repository, reader: {
      async assertChain() { return '4663'; },
      async checkpoint() { assert.equal(resumed, false); return HASH; },
    } }, { runId: '7', retryFailed: true });
    assert.equal(resumed, true);
    assert.equal(result.status, 'completed');
  });
});

describe('Robinhood bundle funding backfill command', () => {
  it('is read-only by default and bounds operational arguments', () => {
    const options = parseArgs(['--lookback-blocks=1000']);
    assert.equal(options.apply, false);
    assert.equal(options.maxMinutes, 285);
    assert.throws(() => parseArgs(['--run-id=7', '--lookback-blocks=1000']), /cannot be combined/);
    assert.throws(() => parseArgs(['--run-id=7', '--retry-failed']), /requires/);
    assert.throws(() => parseArgs(['--lookback-blocks=1000', '--max-minutes=301']), /1 and 300/);
  });

  it('does not execute a resumable campaign without apply', async () => {
    let executed = false;
    const report = await main([], {
      options: parseArgs(['--run-id=7']), env: { DATABASE_URL: 'postgres://test' },
      logger: { log() {}, error() {} }, repository: { async getRun() { return run(); } },
      reader: {}, async execute() { executed = true; },
    });
    assert.equal(report.mode, 'resume-read-only');
    assert.equal(executed, false);
  });
});
