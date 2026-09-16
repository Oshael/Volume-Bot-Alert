'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  parseArgs, restore, runRoutingBackfill,
} = require('../src/utils/backfill-robinhood-head-capture-routing');

function options(overrides = {}) {
  return {
    write: true, audit: false, checkpointFile: '/tmp/unused-routing.json',
    pageBatch: 100, maxBatches: 10, pauseMs: 0,
    statementTimeoutMs: 30_000, maxCanonicalLagBlocks: 128,
    ...overrides,
  };
}

function repository(overrides = {}) {
  return {
    assertRoutingMirrorReady: async () => {},
    describeRoutingPhysicalSource: async () => ({ relationFileNode: '100', heapBlocks: 250 }),
    assertMaintenanceAllowed: async () => {},
    processRoutingPhysicalBatch: async (input) => ({
      ...input, candidates: 10, updated: input.write ? 10 : 0, divergent: 0,
    }),
    ...overrides,
  };
}

describe('Robinhood head capture routing backfill', () => {
  it('defaults to one bounded read-only page batch', () => {
    assert.deepEqual(parseArgs([]), {
      write: false, audit: false, checkpointFile: null, pageBatch: 256, maxBatches: 1,
      pauseMs: 500, statementTimeoutMs: 30_000, maxCanonicalLagBlocks: 128,
    });
    assert.throws(() => parseArgs(['--write']), /checkpoint-file is required/);
    assert.throws(() => parseArgs(['--checkpoint-file=x']), /requires --write/);
    assert.throws(() => parseArgs(['--audit']), /checkpoint-file is required/);
    assert.throws(() => parseArgs(['--write', '--audit', '--checkpoint-file=x']), /mutually exclusive/);
    assert.equal(parseArgs(['--audit', '--checkpoint-file=x']).audit, true);
    assert.throws(() => parseArgs(['--page-batch=4097']), /page-batch must be between/);
    assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  });

  it('refuses stale or malformed write checkpoints', () => {
    const source = { relationFileNode: '100', heapBlocks: 250 };
    const saved = { ...restore(null, source, options()), nextHeapBlock: 100 };
    assert.throws(
      () => restore(saved, { ...source, relationFileNode: '101' }, options()),
      /relation was rewritten/
    );
    assert.throws(
      () => restore({ ...saved, nextHeapBlock: 251 }, source, options()),
      /progress is invalid/
    );
    assert.throws(
      () => restore(saved, source, options({ write: false })),
      /mode or version is invalid/
    );
    const auditOptions = options({ write: false, audit: true });
    const auditSaved = { ...restore(null, source, auditOptions), nextHeapBlock: 100 };
    assert.equal(restore(auditSaved, source, auditOptions).nextHeapBlock, 100);
    assert.throws(() => restore(auditSaved, source, options()), /mode or version is invalid/);
  });

  it('checks lag per batch and checkpoints only completed batches', async () => {
    const calls = [];
    const saved = [];
    const report = await runRoutingBackfill(options(), {
      repository: repository({
        assertRoutingMirrorReady: async () => calls.push('mirror'),
        assertMaintenanceAllowed: async () => calls.push('lag'),
        processRoutingPhysicalBatch: async (input) => {
          calls.push(input);
          return { ...input, candidates: 10, updated: 10, divergent: 0 };
        },
      }),
      checkpoint: {
        load: async () => null,
        save: async (value) => saved.push(structuredClone(value)),
      },
      logger: { log: () => {} },
    });
    assert.deepEqual(
      calls.filter((call) => typeof call === 'object').map(({ startBlock, endBlock }) => (
        [startBlock, endBlock]
      )),
      [[0, 100], [100, 200], [200, 250]]
    );
    assert.equal(calls.filter((call) => call === 'lag').length, 3);
    assert.deepEqual([saved.length, report.completed, report.updated], [3, true, 30]);
    assert.equal(report.requiresFinalAudit, true);
  });

  it('does not advance after a batch error', async () => {
    let saved = false;
    await assert.rejects(runRoutingBackfill(options(), {
      repository: repository({
        processRoutingPhysicalBatch: async () => { throw new Error('parity failed'); },
      }),
      checkpoint: { load: async () => null, save: async () => { saved = true; } },
      logger: { log: () => {} },
    }), /parity failed/);
    assert.equal(saved, false);
  });

  it('never writes a checkpoint in preview mode', async () => {
    let saved = false;
    const report = await runRoutingBackfill(options({ write: false, maxBatches: 1 }), {
      repository: repository(),
      checkpoint: { load: async () => null, save: async () => { saved = true; } },
      logger: { log: () => {} },
    });
    assert.equal(saved, false);
    assert.equal(report.updated, 0);
    assert.equal(report.completed, false);
  });

  it('audits every fixed page range without approving a divergent result', async () => {
    const saved = [];
    const report = await runRoutingBackfill(options({ write: false, audit: true }), {
      repository: repository({
        auditRoutingPhysicalBatch: async ({ startBlock, endBlock }) => ({
          startBlock, endBlock, active: 10, missingPayload: 0,
          divergent: startBlock === 100 ? 1 : 0, incomplete: 0,
        }),
      }),
      checkpoint: {
        load: async () => null,
        save: async (value) => saved.push(structuredClone(value)),
      },
      logger: { log: () => {} },
    });
    assert.deepEqual([saved.length, report.completed, report.active, report.divergent],
      [3, true, 30, 1]);
    assert.equal(report.parityObserved, false);
    assert.equal(report.requiresFinalAudit, true);
    assert.equal(report.requiresPointInTimeGate, true);
  });

  it('reports clean full coverage without granting cutover approval', async () => {
    const report = await runRoutingBackfill(options({ write: false, audit: true }), {
      repository: repository({
        auditRoutingPhysicalBatch: async () => ({
          active: 1, missingPayload: 0, divergent: 0, incomplete: 0,
        }),
      }),
      checkpoint: { load: async () => null, save: async () => {} },
      logger: { log: () => {} },
    });
    assert.equal(report.parityObserved, true);
    assert.equal(report.requiresFinalAudit, false);
    assert.equal(report.requiresPointInTimeGate, true);
  });
});
