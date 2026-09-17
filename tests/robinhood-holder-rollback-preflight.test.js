'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodHolderRollbackPreflight, evaluate,
} = require('../src/services/robinhood-holder-rollback-preflight');
const { main } = require('../src/utils/audit-robinhood-holder-rollback');

const healthy = {
  capture_mode: 'tracked', policy_version: '4', cutover_next_block: '101',
  cutover_checkpoint_block: '100', cutover_checkpoint_hash: 'hash-a',
  holder_next_block: '151', holder_checkpoint_block: '150',
  holder_checkpoint_hash: 'hash-b', capture_checkpoint_block: '155',
  raw_floor_block: '90', cutover_anchor_canonical: true,
  holder_checkpoint_canonical: true,
};

it('reports a bounded reconstruction window without authorizing rollback', () => {
  assert.deepEqual(evaluate(healthy), {
    mode: 'read-only', readyForReconstruction: true, blockers: [],
    reconstruction: {
      fromBlock: '101', throughBlock: '150', rawFloorBlock: '90',
      captureCheckpointBlock: '155',
    },
    policy: { mode: 'tracked', version: '4', cutoverCheckpointBlock: '100' },
    holder: { nextBlock: '151', checkpointBlock: '150' },
  });
  assert.deepEqual(evaluate({ ...healthy, holder_next_block: '101',
    holder_checkpoint_block: '100', holder_checkpoint_hash: 'hash-a' })
    .reconstruction.throughBlock, null);
});

it('fails closed for lost raw retention, changed anchors and unavailable frontiers', () => {
  for (const [change, blocker] of [
    [{ raw_floor_block: '102' }, 'raw_coverage_unavailable'],
    [{ cutover_anchor_canonical: false }, 'cutover_anchor_not_canonical'],
    [{ holder_checkpoint_canonical: false }, 'holder_checkpoint_not_canonical'],
    [{ capture_checkpoint_block: '149' }, 'canonical_capture_behind_holder'],
    [{ holder_next_block: '149' }, 'holder_cursor_invalid'],
    [{ capture_mode: 'legacy' }, 'tracked_policy_required'],
  ]) {
    const result = evaluate({ ...healthy, ...change });
    assert.equal(result.readyForReconstruction, false);
    assert.ok(result.blockers.includes(blocker), blocker);
  }
  assert.equal(evaluate().readyForReconstruction, false);
});

it('uses one read-only snapshot and rolls back even when inspection fails', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT')) return { rows: [healthy] };
      return { rows: [] };
    },
    release() { calls.push('RELEASE'); },
  };
  const audit = createRobinhoodHolderRollbackPreflight({
    database: { getClient: async () => client },
  });
  const output = [];
  const result = await main({ audit, logger: { log: (line) => output.push(line) } });
  assert.equal(result.readyForReconstruction, true);
  assert.deepEqual(JSON.parse(output[0]), result);
  assert.match(calls[0], /REPEATABLE READ READ ONLY/);
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'RELEASE');

  client.query = async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT')) throw new Error('query failed');
    return { rows: [] };
  };
  await assert.rejects(audit.inspect(), /query failed/);
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'RELEASE');
});
