const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runGlobalHolderDelta,
} = require('../src/utils/create-robinhood-holder-global-delta');

function harness(active, completedCutoff = '2026-08-13T00:00:00Z') {
  let creates = 0;
  const previews = [];
  const createdInputs = [];
  return {
    database: { query: async (sql) => (
      sql.includes('SELECT catalog_cutoff')
        ? { rowCount: 1, rows: [{ catalog_cutoff: completedCutoff }] }
        : { rows: [{ active }] }
    ) },
    repository: {
      previewRun: async (input) => {
        previews.push(input);
        return { candidateTokens: 2 };
      },
      createRun: async (input) => {
        creates += 1;
        createdInputs.push(input);
        return { runId: '2', status: 'frozen' };
      },
    },
    creates: () => creates,
    previews,
    createdInputs,
  };
}

describe('Robinhood holder global delta command', () => {
  it('reports an active incremental lease without mutating in dry-run mode', async () => {
    const fixture = harness(true);
    const result = await runGlobalHolderDelta({
      ...fixture, catalogCutoff: '2026-08-14T00:00:00Z',
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.incrementalBackfillActive, true);
    assert.equal(fixture.creates(), 0);
  });

  it('refuses confirmation while the incremental lease is active', async () => {
    const fixture = harness(true);
    await assert.rejects(runGlobalHolderDelta({
      ...fixture, catalogCutoff: '2026-08-14T00:00:00Z', confirm: true,
    }), { code: 'holder_global_delta_incremental_active' });
    assert.equal(fixture.creates(), 0);
  });

  it('uses the same backfilling-only scope for preview and confirmation', async () => {
    const fixture = harness(false);
    const result = await runGlobalHolderDelta({
      ...fixture, catalogCutoff: '2026-08-14T00:00:00Z',
      includeUnseeded: false, confirm: true,
    });

    assert.equal(result.mode, 'confirmed');
    assert.deepEqual(fixture.previews, [{
      catalogCutoff: '2026-08-14T00:00:00Z', includeUnseeded: false,
    }]);
    assert.deepEqual(fixture.createdInputs, fixture.previews);
  });

  it('uses the latest completed run cutoff as the immutable candidate floor', async () => {
    const fixture = harness(false);
    const result = await runGlobalHolderDelta({
      ...fixture, catalogCutoff: '2026-08-14T00:00:00Z',
      includeUnseeded: false, sinceLatestCompletedRun: true,
      maximumGapBlocks: 500_000,
    });

    assert.equal(result.catalogFloor, '2026-08-13T00:00:00.000Z');
    assert.equal(result.maxScanBlocks, 500_000);
    assert.deepEqual(fixture.previews, [{
      catalogCutoff: '2026-08-14T00:00:00Z', includeUnseeded: false,
      catalogFloor: '2026-08-13T00:00:00.000Z',
      maximumGapBlocks: 500_000,
    }]);
  });

  it('creates the frozen delta after the incremental lease stops', async () => {
    const fixture = harness(false);
    const result = await runGlobalHolderDelta({
      ...fixture, catalogCutoff: '2026-08-14T00:00:00Z', confirm: true,
    });
    assert.equal(result.mode, 'confirmed');
    assert.equal(result.created.runId, '2');
    assert.equal(fixture.creates(), 1);
  });
});
