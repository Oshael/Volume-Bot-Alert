'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  APPLY_SQL, INSPECT_SQL, createRobinhoodBundleFundingArchiveReconciliation,
} = require('../src/models/robinhood-bundle-funding-archive-reconciliation');
const {
  main, parseArgs,
} = require('../src/utils/reconcile-robinhood-bundle-funding-archive');

describe('Robinhood bundle funding Archive reconciliation', () => {
  it('is read-only by default and requires explicit apply confirmation', () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, confirmed: false, limit: 100,
    });
    assert.throws(() => parseArgs(['--apply']), /requires --confirm-reconcile/);
    assert.throws(() => parseArgs(['--confirm-reconcile-archive-funding']), /requires --apply/);
    assert.throws(() => parseArgs(['--limit=1001']), /between 1 and 1000/);
    assert.deepEqual(parseArgs([
      '--apply', '--confirm-reconcile-archive-funding', '--limit=1000',
    ]), { apply: true, confirmed: true, limit: 1000 });
  });

  it('accepts only a version-fenced durable snapshot or a proven negative result', () => {
    assert.match(INSPECT_SQL, /state\.source_version >= queue\.requested_version/);
    assert.match(INSPECT_SQL, /run\.status = 'completed'/);
    assert.match(INSPECT_SQL, /candidate\.launch_block = queue\.anchor_block/);
    assert.match(INSPECT_SQL, /holder\.ledger_status = 'live'/);
    assert.match(INSPECT_SQL, /holder\.live_through_block >= queue\.source_through_block/);
    assert.match(INSPECT_SQL, /cursor\.source_next_block > queue\.source_through_block/);
    assert.match(INSPECT_SQL, /seed\.status = 'completed'/);
    assert.match(INSPECT_SQL, /LIMIT 2/);
    assert.match(APPLY_SQL, /queue\.requested_version = selected\.requested_version/);
    assert.doesNotMatch(INSPECT_SQL, /\bUPDATE\b/);
  });

  it('reports reasons and leaves unresolved Archive work visible', async () => {
    const queries = [];
    const database = { async query(sql) {
      queries.push(sql);
      if (sql === INSPECT_SQL) return { rows: [{
        token_address: `0x${'1'.repeat(40)}`, requested_version: '7',
        repair_reason: 'durable_snapshot',
      }, {
        token_address: `0x${'2'.repeat(40)}`, requested_version: '3',
        repair_reason: 'insufficient_candidates',
      }] };
      return { rows: [{ remaining: 19 }] };
    } };
    const result = await createRobinhoodBundleFundingArchiveReconciliation({ database })
      .run({ limit: 25 });
    assert.deepEqual(result.repaired, {
      durable_snapshot: 1, insufficient_candidates: 1,
    });
    assert.equal(result.remainingArchiveRequired, 19);
    assert.equal(queries[0], INSPECT_SQL);
  });

  it('passes the guarded mode to the repository', async () => {
    let received; let printed;
    await main(['--apply', '--confirm-reconcile-archive-funding', '--limit=5'], {
      reconciliation: { async run(options) { received = options; return { mode: 'apply' }; } },
      logger: { log(value) { printed = value; } },
    });
    assert.deepEqual(received, { apply: true, confirmed: true, limit: 5 });
    assert.match(printed, /"mode": "apply"/);
  });
});
