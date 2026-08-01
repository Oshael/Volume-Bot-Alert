const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { runSeedBatch, runSeed } = require('../src/services/robinhood-wallet-swap-seed-runner');

function fakeAttributor(totals = { attributed: 1, inserted: 1, unresolved: 0, missing: 0 }) {
  const seen = [];
  return {
    seen,
    attributeGroups: async (groups) => { seen.push(groups); return { ...totals }; },
  };
}

// cursor stub with a mutable state and optional version-conflict on advance.
function fakeCursor(state, { conflict = false } = {}) {
  const advances = [];
  return {
    advances,
    loadCursor: async () => (state ? { ...state } : null),
    advanceCursor: async (stream, input) => {
      advances.push({ stream, input });
      if (conflict) return null;
      state = { ...state, nextBlock: input.nextBlock, version: state.version + 1 };
      return { ...state };
    },
  };
}

function fakeReader(sequence) {
  const queue = [...sequence];
  return {
    readAcceptedBlockGroups: async () => queue.shift() || { groups: [], blockNumbers: [] },
  };
}

describe('robinhood wallet swap seed runner', () => {
  it('attributes a block group and advances the cursor past the last block', async () => {
    const reader = fakeReader([{ groups: [['100', [{}]], ['101', [{}]]], blockNumbers: ['100', '101'] }]);
    const attributor = fakeAttributor({ attributed: 2, inserted: 2, unresolved: 0, missing: 0 });
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '100', safeHead: '200', version: 0 });

    const result = await runSeedBatch({ reader, attributor, cursor });
    assert.equal(result.done, false);
    assert.equal(result.processedBlocks, 2);
    assert.equal(result.nextBlock, '102'); // lastBlock 101 + 1
    assert.deepEqual(cursor.advances[0].input, { nextBlock: '102', expectedVersion: 0 });
    assert.equal(result.totals.inserted, 2);
  });

  it('reports done without advancing when no accepted blocks remain', async () => {
    const reader = fakeReader([{ groups: [], blockNumbers: [] }]);
    const attributor = fakeAttributor();
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '150', safeHead: '200', version: 3 });

    const result = await runSeedBatch({ reader, attributor, cursor });
    assert.equal(result.done, true);
    assert.equal(result.processedBlocks, 0);
    assert.equal(cursor.advances.length, 0);
    assert.equal(attributor.seen.length, 0);
  });

  it('is done immediately when the cursor has passed the target', async () => {
    const reader = fakeReader([]);
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '201', safeHead: '200', version: 0 });
    const result = await runSeedBatch({ reader, attributor: fakeAttributor(), cursor });
    assert.equal(result.done, true);
    assert.equal(result.processedBlocks, 0);
  });

  it('stops on a cursor version conflict (another owner advanced)', async () => {
    const reader = fakeReader([{ groups: [['100', [{}]]], blockNumbers: ['100'] }]);
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '100', safeHead: '200', version: 0 }, { conflict: true });
    const result = await runSeedBatch({ reader, attributor: fakeAttributor(), cursor });
    assert.equal(result.conflict, true);
    assert.equal(result.done, true);
  });

  it('does not advance past unresolved transactions', async () => {
    const reader = fakeReader([{
      groups: [['100', [{}]]], blockNumbers: ['100'],
    }]);
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '100', safeHead: '200', version: 0 });
    const result = await runSeedBatch({
      reader,
      attributor: fakeAttributor({ attributed: 0, inserted: 0, unresolved: 1, missing: 1 }),
      cursor,
    });

    assert.equal(result.blocked, 'unresolved');
    assert.equal(result.done, true);
    assert.equal(cursor.advances.length, 0);

    const summary = await runSeed({
      reader: fakeReader([{ groups: [['100', [{}]]], blockNumbers: ['100'] }]),
      attributor: fakeAttributor({ attributed: 0, inserted: 0, unresolved: 1, missing: 1 }),
      cursor: fakeCursor({ stream: 'seed', nextBlock: '100', safeHead: '200', version: 0 }),
      logger: { log() {}, warn() {} },
    });
    assert.equal(summary.stopped, 'unresolved');
  });

  it('throws when the cursor is not initialized', async () => {
    const cursor = fakeCursor(null);
    await assert.rejects(
      () => runSeedBatch({ reader: fakeReader([]), attributor: fakeAttributor(), cursor }),
      /cursor is not initialized/
    );
  });

  it('loops batches until complete and aggregates the summary', async () => {
    const reader = fakeReader([
      { groups: [['100', [{}]]], blockNumbers: ['100'] },
      { groups: [['101', [{}]]], blockNumbers: ['101'] },
      { groups: [], blockNumbers: [] },
    ]);
    const attributor = fakeAttributor({ attributed: 1, inserted: 1, unresolved: 0, missing: 0 });
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '100', safeHead: '200', version: 0 });

    const summary = await runSeed({ reader, attributor, cursor, logger: { log() {}, warn() {} } });
    assert.equal(summary.batches, 2);
    assert.equal(summary.processedBlocks, 2);
    assert.equal(summary.inserted, 2);
    assert.equal(summary.stopped, 'complete');
  });

  it('respects a maxBatches limit', async () => {
    const reader = fakeReader([
      { groups: [['100', [{}]]], blockNumbers: ['100'] },
      { groups: [['101', [{}]]], blockNumbers: ['101'] },
    ]);
    const cursor = fakeCursor({ stream: 'seed', nextBlock: '100', safeHead: '200', version: 0 });
    const summary = await runSeed({
      reader, attributor: fakeAttributor(), cursor, maxBatches: 1, logger: { log() {}, warn() {} },
    });
    assert.equal(summary.batches, 1);
    assert.equal(summary.stopped, 'batch-limit');
  });
});
