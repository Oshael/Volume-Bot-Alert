'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  parseArgs, runBackfill,
} = require('../src/utils/backfill-robinhood-head-capture-states');
const { __private } = require('../src/models/robinhood-head-capture-state');

describe('Robinhood head capture state backfill', () => {
  it('is dry-run by default and requires a checkpoint for writes', () => {
    assert.deepEqual(parseArgs([]), {
      write: false, batchSize: 1000, maxBatches: 1, pauseMs: 250,
      statementTimeoutMs: 30000, maxCanonicalLagBlocks: 128, checkpointFile: null,
    });
    assert.throws(() => parseArgs(['--write']), /checkpoint-file is required/);
    assert.throws(() => parseArgs(['--batch-size=5001']), /batch-size must be between/);
    assert.throws(() => parseArgs(['--unknown=true']), /unknown argument/);
  });

  it('admits bounded canonical lag and rejects an invalid or excessive frontier', () => {
    assert.equal(__private.maintenanceLag({
      capture_next_block: '1000', first_unsettled_block: '900',
    }, 100), '100');
    assert.throws(() => __private.maintenanceLag({
      capture_next_block: '1000', first_unsettled_block: '899',
    }, 100), /canonical lag 101/);
    assert.throws(() => __private.maintenanceLag({
      capture_next_block: '1000', first_unsettled_block: '1001',
    }, 100), /frontier is invalid/);
  });

  it('persists progress after each bounded batch and approves only a complete write', async () => {
    const calls = [];
    const saved = [];
    const firstCursor = { transactionHash: `0x${'1'.repeat(64)}`, logIndex: '1' };
    const batches = [{
      scanned: 2, inserted: 2, checked: 2, missing: 0, divergent: 0,
      next: firstCursor, complete: false,
    }, {
      scanned: 1, inserted: 1, checked: 1, missing: 0, divergent: 0,
      next: { transactionHash: `0x${'2'.repeat(64)}`, logIndex: '0' }, complete: true,
    }];
    const repository = {
      assertMirrorReady: async () => { calls.push('ready'); },
      assertMaintenanceAllowed: async () => { calls.push('allowed'); },
      processBatch: async (input) => { calls.push(input); return batches.shift(); },
    };
    const report = await runBackfill({
      write: true, batchSize: 2, maxBatches: 2, pauseMs: 0,
      statementTimeoutMs: 5000, maxCanonicalLagBlocks: 128,
      checkpointFile: '/tmp/unused.json',
    }, {
      repository,
      checkpoint: {
        load: async () => null,
        save: async (value) => saved.push(structuredClone(value)),
      },
      logger: { log: () => {} },
    });

    assert.equal(calls[0], 'ready');
    assert.equal(calls[1], 'allowed');
    assert.equal(calls[2].after, null);
    assert.equal(calls[3], 'allowed');
    assert.deepEqual(calls[4].after, firstCursor);
    assert.equal(saved.length, 2);
    assert.deepEqual(
      [report.completed, report.approved, report.batches, report.scanned, report.inserted],
      [true, true, 2, 3, 3]
    );
  });

  it('does not advance the checkpoint when parity fails', async () => {
    let saved = false;
    const report = await runBackfill({
      write: true, batchSize: 100, maxBatches: 1, pauseMs: 0,
      statementTimeoutMs: 5000, maxCanonicalLagBlocks: 128,
      checkpointFile: '/tmp/unused.json',
    }, {
      repository: {
        assertMirrorReady: async () => {},
        assertMaintenanceAllowed: async () => {},
        processBatch: async () => ({
          scanned: 100, inserted: 0, checked: 100, missing: 1, divergent: 0,
          next: null, complete: false,
        }),
      },
      checkpoint: { load: async () => null, save: async () => { saved = true; } },
      logger: { log: () => {} },
    });
    assert.deepEqual(report.blocked, { missing: 1, divergent: 0 });
    assert.equal(report.approved, false);
    assert.equal(saved, false);
  });
});
