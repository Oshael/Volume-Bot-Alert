const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  __private: { backfillFrontier, sourceFrontier },
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
