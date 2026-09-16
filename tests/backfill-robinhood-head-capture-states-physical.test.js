'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  parseArgs, restore, runPhysicalBackfill,
} = require('../src/utils/backfill-robinhood-head-capture-states-physical');

function options(overrides = {}) {
  return {
    write: true, pageBatch: 100, maxBatches: 10, pauseMs: 0,
    statementTimeoutMs: 30_000, maxCanonicalLagBlocks: 128,
    shardCount: 1, shardIndex: 0, targetHeapBlocks: null,
    checkpointFile: '/tmp/unused-physical.json', ...overrides,
  };
}

describe('Robinhood physical head capture state backfill', () => {
  it('defaults to a bounded read-only physical scan', () => {
    assert.deepEqual(parseArgs([]), {
      write: false, pageBatch: 2048, maxBatches: 1, pauseMs: 0,
      statementTimeoutMs: 30_000, maxCanonicalLagBlocks: 128,
      shardCount: 1, shardIndex: 0, targetHeapBlocks: null,
      checkpointFile: null,
    });
    assert.throws(() => parseArgs(['--write']), /checkpoint-file is required/);
    assert.throws(() => parseArgs(['--page-batch=65537']), /page-batch must be between/);
    assert.throws(() => parseArgs(['--shard-count=4', '--shard-index=4']), /lower/);
    assert.throws(() => parseArgs(['--shard-count=4']), /target-heap-blocks is required/);
  });

  it('rejects a checkpoint after a relation rewrite', () => {
    const saved = {
      version: 2, mode: 'write', relationFileNode: '100', shardCount: 1, shardIndex: 0,
      sourceHeapBlocks: 1000, startHeapBlock: 0, targetHeapBlocks: 1000,
      nextHeapBlock: 100,
      completed: false, batches: 1, scanned: 10, inserted: 10,
    };
    assert.throws(
      () => restore(saved, { relationFileNode: '101', heapBlocks: 1000 }, options()),
      /relation was rewritten/
    );
    assert.throws(
      () => restore({ ...saved, nextHeapBlock: 1001 }, {
        relationFileNode: '100', heapBlocks: 1000,
      }, options()),
      /checkpoint progress is invalid/
    );
  });

  it('partitions heap pages into disjoint complete shards', () => {
    const source = { relationFileNode: '100', heapBlocks: 10 };
    const ranges = Array.from({ length: 4 }, (_, shardIndex) => restore(
      null, source, options({ shardCount: 4, shardIndex, targetHeapBlocks: 10 })
    )).map(({ startHeapBlock, targetHeapBlocks }) => [startHeapBlock, targetHeapBlocks]);
    assert.deepEqual(ranges, [[0, 2], [2, 5], [5, 7], [7, 10]]);
  });

  it('checkpoints each page range and approves only the completed write', async () => {
    const calls = [];
    const saved = [];
    const repository = {
      assertMirrorReady: async () => calls.push('ready'),
      describePhysicalSource: async () => ({ relationFileNode: '100', heapBlocks: 250 }),
      assertMaintenanceAllowed: async () => calls.push('allowed'),
      processPhysicalBatch: async (input) => {
        calls.push(input);
        return { ...input, scanned: 10, inserted: 8, checked: 10, missing: 0, divergent: 0 };
      },
    };
    const report = await runPhysicalBackfill(options(), {
      repository,
      checkpoint: {
        load: async () => null,
        save: async (value) => saved.push(structuredClone(value)),
      },
      logger: { log: () => {} },
    });

    assert.equal(report.completed, true);
    assert.equal(report.approved, true);
    assert.deepEqual(
      calls.filter((call) => typeof call === 'object').map(({ startBlock, endBlock }) => (
        [startBlock, endBlock]
      )),
      [[0, 100], [100, 200], [200, 250]]
    );
    assert.deepEqual(
      [saved.length, report.batches, report.scanned, report.inserted],
      [3, 3, 30, 24]
    );
  });

  it('does not advance the physical checkpoint when parity fails', async () => {
    let saved = false;
    const report = await runPhysicalBackfill(options({ maxBatches: 1 }), {
      repository: {
        assertMirrorReady: async () => {},
        describePhysicalSource: async () => ({ relationFileNode: '100', heapBlocks: 250 }),
        assertMaintenanceAllowed: async () => {},
        processPhysicalBatch: async () => ({
          scanned: 10, inserted: 0, checked: 10, missing: 1, divergent: 0,
        }),
      },
      checkpoint: { load: async () => null, save: async () => { saved = true; } },
      logger: { log: () => {} },
    });
    assert.deepEqual(report.blocked, { missing: 1, divergent: 0 });
    assert.equal(report.nextHeapBlock, 0);
    assert.equal(saved, false);
  });
});
