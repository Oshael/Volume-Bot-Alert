const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBundleRedistributionControlPlane, __private,
} = require('../src/models/robinhood-bundle-redistribution-control-plane');

const HASH = `0x${'a'.repeat(64)}`;
const planned = Object.freeze({ status: 'planned', activationBlock: '100' });
const source = (name, nextBlock, checkpointBlock = null) => Object.freeze({
  source: name, lifecycleState: 'running', nextBlock: String(nextBlock),
  checkpointBlock: checkpointBlock == null ? null : String(checkpointBlock),
  checkpointHash: checkpointBlock == null ? null : HASH,
});

describe('Robinhood BUNDLED redistribution control plane', () => {
  it('requires both source frontiers beyond the boundary and one later checkpoint', () => {
    const ready = __private.assess(planned, [
      source('wallet_swaps', 102, 90), source('wallet_transfers', 103, 101),
    ]);
    assert.equal(ready.ready, true);
    assert.equal(ready.checkpoint.source, 'wallet_transfers');

    const blocked = __private.assess(planned, [
      source('wallet_swaps', 100, 90), source('wallet_transfers', 103, 99),
    ]);
    assert.deepEqual(blocked.reasons, [
      'wallet_swaps_before_activation', 'canonical_checkpoint_after_activation_missing',
    ]);
  });

  it('reserves a future boundary without activating or scanning history', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.includes('FROM robinhood_bundle_redistribution_activations')) {
          return { rows: [] };
        }
        if (sql.includes("SELECT 'wallet_swaps'")) return { rows: [
          { source: 'wallet_swaps', lifecycle_state: 'running', next_block: '200',
            checkpoint_block: '199', checkpoint_hash: HASH },
          { source: 'wallet_transfers', lifecycle_state: 'running', next_block: '190',
            checkpoint_block: '189', checkpoint_hash: HASH },
        ] };
        if (sql.includes('INSERT INTO')) return { rows: [{
          status: 'planned', activation_at: new Date('2026-09-01T00:00:00Z'),
          activation_block: params[3], activation_checkpoint_block: null,
          activation_checkpoint_hash: null, activated_at: null,
        }] };
        throw new Error(`unexpected SQL: ${sql}`);
      },
      release() {},
    };
    const control = createRobinhoodBundleRedistributionControlPlane({
      database: { async getClient() { return client; } },
    });
    const result = await control.apply({ leadBlocks: 100 });
    assert.equal(result.action, 'reserved');
    assert.equal(result.activation.activationBlock, '300');
    assert.equal(calls.some(({ sql }) => /eth_get|wallet_swaps\s+WHERE/.test(sql)), false);
  });

  it('promotes only with a durable checkpoint after the reserved boundary', async () => {
    const client = {
      async query(sql, params) {
        if (['BEGIN', 'COMMIT'].includes(sql)) return { rows: [] };
        if (sql.includes('FROM robinhood_bundle_redistribution_activations')) {
          return { rows: [{ status: 'planned', activation_at: new Date(0),
            activation_block: '100', activation_checkpoint_block: null,
            activation_checkpoint_hash: null, activated_at: null }] };
        }
        if (sql.includes("SELECT 'wallet_swaps'")) return { rows: [
          { source: 'wallet_swaps', lifecycle_state: 'running', next_block: '102',
            checkpoint_block: '99', checkpoint_hash: HASH },
          { source: 'wallet_transfers', lifecycle_state: 'running', next_block: '103',
            checkpoint_block: '101', checkpoint_hash: HASH },
        ] };
        if (sql.includes('UPDATE')) return { rows: [{ status: 'active',
          activation_at: new Date(0), activation_block: '100',
          activation_checkpoint_block: params[2], activation_checkpoint_hash: params[3],
          activated_at: new Date('2026-09-01T00:00:00Z') }] };
        throw new Error(`unexpected SQL: ${sql}`);
      },
      release() {},
    };
    const control = createRobinhoodBundleRedistributionControlPlane({
      database: { async getClient() { return client; } },
    });
    const result = await control.apply();
    assert.equal(result.action, 'activated');
    assert.equal(result.activation.checkpointBlock, '101');
  });
});
