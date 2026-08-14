const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runGlobalHolderDelta,
} = require('../src/utils/create-robinhood-holder-global-delta');

function harness(active) {
  let creates = 0;
  return {
    database: { query: async () => ({ rows: [{ active }] }) },
    repository: {
      previewRun: async () => ({ candidateTokens: 2 }),
      createRun: async () => {
        creates += 1;
        return { runId: '2', status: 'frozen' };
      },
    },
    creates: () => creates,
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
