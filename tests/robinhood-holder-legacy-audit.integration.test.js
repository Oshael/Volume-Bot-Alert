'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { createRobinhoodHolderLegacyAudit } = require('../src/services/robinhood-holder-legacy-audit');

after(() => db.pool.end());

it('runs the bounded read-only legacy diagnosis against PostgreSQL', async () => {
  const audit = createRobinhoodHolderLegacyAudit({ database: { async getClient() {
    const client = await db.getClient();
    return {
      async query(sql, params) {
        if (sql.includes('FROM robinhood_holder_cursors cursor')) return { rows: [{
          next_block: '1000000000000001', checkpoint_block: '1000000000000000',
          checkpoint_hash: `0x${'a'.repeat(64)}`, journal_floor_block: '1000000000000000',
          capture_checkpoint_block: '1000000000000000', raw_floor_block: '1000000000000000',
        }] };
        return client.query(sql, params);
      },
      release: () => client.release(),
    };
  } } });
  const result = await audit.inspect();
  assert.equal(result.mode, 'read-only');
  assert.ok(result.stateGroups.every((group) => Number.isSafeInteger(group.total)));
  assert.ok(result.legacyBackfilling.length <= 4);
  assert.ok(result.legacyPromotedSamples.length <= 8);
  assert.equal(typeof result.globalCohort.activeTokens, 'number');
  assert.equal(typeof result.manifestCoverage.currentManifest, 'number');
  assert.equal(result.legacyShadowWithoutCheckpoint.total,
    result.legacyShadowWithoutCheckpoint.withPending
      + result.legacyShadowWithoutCheckpoint.withoutPending);
  assert.ok(result.legacyShadowWithoutCheckpoint.total
    >= result.legacyShadowWithoutCheckpoint.baselineCoverageEligible);
  assert.ok(result.cohortSelectionPlan.nodes.length >= 1);
});
