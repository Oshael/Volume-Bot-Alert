const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  parseArgs,
  runBlockedRecovery,
} = require('../src/utils/requeue-robinhood-processing-blocked');

function fakeRepository(options = {}) {
  const calls = { previews: [], requeues: [] };
  const batches = [...(options.batches || [])];
  return {
    calls,
    async previewBlockedRecovery(input) {
      calls.previews.push(input);
      return options.previews?.shift() || {
        workerActive: false,
        candidates: 2,
        oldestBlock: '100',
        newestBlock: '101',
        hasMore: false,
      };
    },
    async requeueBlockedRecoveryBatch(input) {
      calls.requeues.push(input);
      return batches.shift() || { requeued: 0, oldestBlock: null, newestBlock: null };
    },
  };
}

describe('Robinhood processing blocked recovery CLI', () => {
  it('parses a bounded confirmed recovery and requires an explicit frontier', () => {
    assert.deepEqual(parseArgs([
      '--apply', '--through-block=49430131', '--batch-size=5000', '--max-batches=20',
    ]), {
      apply: true,
      batchSize: 5000,
      maxBatches: 20,
      throughBlock: '49430131',
    });
    assert.throws(() => parseArgs(['--apply']), /through-block is required/);
    assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
  });

  it('previews without mutating the queue', async () => {
    const repository = fakeRepository();
    const result = await runBlockedRecovery({ repository, batchSize: 100 });

    assert.equal(result.mode, 'dry-run');
    assert.equal(result.before.candidates, 2);
    assert.deepEqual(repository.calls.requeues, []);
  });

  it('refuses confirmed recovery while the processing lease is active', async () => {
    const repository = fakeRepository({ previews: [{
      workerActive: true, candidates: 1, oldestBlock: '100', newestBlock: '100', hasMore: false,
    }] });

    await assert.rejects(
      runBlockedRecovery({ repository, apply: true, throughBlock: '100' }),
      /worker must be stopped/
    );
    assert.deepEqual(repository.calls.requeues, []);
  });

  it('requeues bounded batches and stops after a short final batch', async () => {
    const repository = fakeRepository({
      previews: [
        { workerActive: false, candidates: 2, oldestBlock: '100', newestBlock: '101', hasMore: true },
        { workerActive: false, candidates: 0, oldestBlock: null, newestBlock: null, hasMore: false },
      ],
      batches: [
        { requeued: 2, oldestBlock: '100', newestBlock: '101' },
        { requeued: 1, oldestBlock: '102', newestBlock: '102' },
      ],
    });
    const progress = [];

    const result = await runBlockedRecovery({
      repository,
      apply: true,
      throughBlock: '200',
      batchSize: 2,
      maxBatches: 10,
      onProgress: (batch) => progress.push(batch.requeued),
    });

    assert.equal(result.requeued, 3);
    assert.equal(result.batches.length, 2);
    assert.deepEqual(progress, [2, 1]);
    assert.deepEqual(repository.calls.requeues, [
      { limit: 2, throughBlock: '200' },
      { limit: 2, throughBlock: '200' },
    ]);
  });
});
