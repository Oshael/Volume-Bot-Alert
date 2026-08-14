const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  __private: { backfillFrontier, sourceFrontier, transferBackfillPlan },
} = require('../src/models/robinhood-wallet-transfer-live-source');

const BASE = Object.freeze({
  stream: 'live', origin_block: '101',
  next_block: '120', safe_head: '150', checkpoint_block: '119',
  checkpoint_hash: `0x${'a'.repeat(64)}`,
  checkpoint_timestamp: '2099-01-01T00:00:00.000Z',
  lifecycle_state: 'running', version: '3',
});
const SEED = Object.freeze({
  stream: 'seed', origin_block: '90', next_block: '101', safe_head: '100',
  lifecycle_state: 'complete', completed_at: '2099-01-01T00:00:00.000Z',
});

describe('Robinhood wallet transfer LIVE source frontier', () => {
  it('fails closed for every incomplete source state', () => {
    const cases = [
      [null, 'swap_live_missing'],
      [{ ...BASE, lifecycle_state: 'pending' }, 'swap_live_not_running'],
      [{ ...BASE, next_block: '0' }, 'swap_live_frontier_invalid'],
      [{ ...BASE, safe_head: '100' }, 'swap_live_frontier_unproven'],
      [{ ...BASE, checkpoint_hash: null }, 'swap_live_checkpoint_invalid'],
      [{ ...BASE, checkpoint_block: '120' }, 'swap_live_checkpoint_invalid'],
    ];
    for (const [row, reason] of cases) {
      assert.deepEqual(sourceFrontier(row).reason, reason);
    }
  });

  it('publishes only the fully attributed through-block', () => {
    const result = sourceFrontier(BASE);
    assert.equal(result.ready, true);
    assert.equal(result.completeThroughBlock, '119');
    assert.equal(result.version, 3);
  });
});

describe('Robinhood wallet transfer backfill source frontier', () => {
  it('requires a valid completed seed before exposing historical coverage', () => {
    const cases = [
      [[BASE], 'swap_seed_missing'],
      [[{ ...SEED, lifecycle_state: 'running', completed_at: null }, BASE],
        'swap_seed_not_complete'],
      [[{ ...SEED, next_block: '100' }, BASE], 'swap_seed_terminal_invalid'],
      [[{ ...SEED, origin_block: null }, BASE], 'swap_seed_origin_missing'],
      [[{ ...SEED, origin_block: '101' }, BASE], 'swap_seed_origin_invalid'],
      [[SEED, { ...BASE, lifecycle_state: 'pending' }], 'swap_live_not_running'],
      [[SEED, { ...BASE, origin_block: null }], 'swap_live_origin_missing'],
      [[SEED, { ...BASE, origin_block: '102' }], 'swap_live_origin_discontinuous'],
    ];
    for (const [rows, reason] of cases) assert.equal(backfillFrontier(rows).reason, reason);
  });

  it('publishes the proven historical and current swap frontiers', () => {
    const result = backfillFrontier([SEED, BASE]);
    assert.equal(result.ready, true);
    assert.equal(result.historicalFromBlock, '90');
    assert.equal(result.historicalThroughBlock, '100');
    assert.equal(result.completeThroughBlock, '119');
  });
});

function transferCursor(stream, overrides = {}) {
  return {
    stream, origin_block: stream === 'live' ? '110' : '90',
    next_block: stream === 'live' ? '120' : '95', safe_head: stream === 'seed' ? '109' : '150',
    lifecycle_state: 'running', completed_at: null, version: 1, ...overrides,
  };
}

describe('Robinhood wallet transfer seed plan', () => {
  const swap = backfillFrontier([SEED, BASE]);

  it('plans exactly through the block before the durable LIVE origin', () => {
    const plan = transferBackfillPlan(swap, [transferCursor('live')]);
    assert.equal(plan.ready, true);
    assert.equal(plan.status, 'uninitialized');
    assert.equal(plan.fromBlock, '90');
    assert.equal(plan.throughBlock, '109');
    assert.equal(plan.remainingBlocks, '20');
  });

  it('resumes only a seed with identical immutable boundaries', () => {
    const running = transferBackfillPlan(swap, [
      transferCursor('live'), transferCursor('seed'),
    ]);
    assert.equal(running.status, 'running');
    assert.equal(running.nextBlock, '95');
    assert.equal(running.remainingBlocks, '15');

    const complete = transferBackfillPlan(swap, [
      transferCursor('live'),
      transferCursor('seed', {
        next_block: '110', lifecycle_state: 'complete', completed_at: '2099-01-01T00:00:00Z',
      }),
    ]);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.remainingBlocks, '0');
  });

  it('fails closed for gaps, overlap and cursor boundary conflicts', () => {
    const cases = [
      [[], 'transfer_live_missing'],
      [[transferCursor('live', { origin_block: null })], 'transfer_live_origin_missing'],
      [[transferCursor('live', { origin_block: '89' })],
        'transfer_live_origin_before_swap_coverage'],
      [[transferCursor('live', { origin_block: '121', next_block: '130' })],
        'transfer_seed_target_beyond_swap_coverage'],
      [[transferCursor('live'), transferCursor('seed', { origin_block: '91' })],
        'transfer_seed_origin_conflict'],
      [[transferCursor('live'), transferCursor('seed', { safe_head: '108' })],
        'transfer_seed_target_conflict'],
    ];
    for (const [rows, reason] of cases) {
      assert.equal(transferBackfillPlan(swap, rows).reason, reason);
    }
  });
});
