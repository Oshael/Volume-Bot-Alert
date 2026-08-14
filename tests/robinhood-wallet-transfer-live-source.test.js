const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  __private: { sourceFrontier },
} = require('../src/models/robinhood-wallet-transfer-live-source');

const BASE = Object.freeze({
  next_block: '120', safe_head: '150', checkpoint_block: '119',
  checkpoint_hash: `0x${'a'.repeat(64)}`,
  checkpoint_timestamp: '2099-01-01T00:00:00.000Z',
  lifecycle_state: 'running', version: '3',
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
