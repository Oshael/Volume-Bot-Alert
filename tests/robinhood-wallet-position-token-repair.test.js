const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRobinhoodWalletPositionTokenRepairRepository,
} = require('../src/models/robinhood-wallet-position-token-repair');
const {
  runRobinhoodWalletPositionTokenRepairRange,
} = require('../src/services/robinhood-wallet-position-token-repair-runner');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

test('initializes only published transfer repairs added after the position seed began', async () => {
  let captured;
  const repository = createRobinhoodWalletPositionTokenRepairRepository({
    database: { async query(sql, params) {
      captured = { sql, params };
      return { rowCount: 391, rows: [] };
    } },
  });
  assert.deepEqual(await repository.initialize(), { inserted: 391 });
  assert.match(captured.sql, /transfer\.published_at IS NOT NULL/);
  assert.match(captured.sql, /state\.created_at > seed\.created_at/);
  assert.match(captured.sql, /ON CONFLICT .* DO NOTHING/s);
  assert.deepEqual(captured.params, [
    'robinhood', 'unified_transfer_v1',
    'unified_transfer_token_repair_v1', 'rh_transfer_v1',
  ]);
});

test('replays a bounded range into shadow positions and advances token coverage', async () => {
  let committed;
  const coverage = {
    async claim() {
      return { tokenAddress: TOKEN, nextBlock: '100', sourceThroughBlock: '199' };
    },
    async commitShadowRange(input) {
      committed = input;
      return { complete: false, positions: input.positions.length };
    },
    async retry() { throw new Error('unexpected retry'); },
  };
  const result = await runRobinhoodWalletPositionTokenRepairRange({
    coverage,
    tickDeps: { evidence: { async matchesCheckpoint() { return true; } } },
    async prepareRange() {
      return {
        captured: {
          fromBlockTime: '2026-01-01T00:00:00.000Z',
          checkpoint: { number: '149', hash: HASH, blockTime: '2026-01-01T00:01:00.000Z' },
        },
        classified: { events: [] },
      };
    },
    positions: {
      async readUnifiedRangeSwaps() {
        return [{
          token_address: TOKEN, wallet_address: WALLET, transaction_hash: HASH,
          transaction_index: '0', block_number: '120', action_index: '0',
          side: 'buy', token_amount_raw: '10', volume_usd: '5', market_cap_usd: '100',
        }];
      },
      async loadPositions(version) {
        assert.equal(version, 'unified_transfer_token_repair_v1');
        return [];
      },
    },
    transactionPositions: {
      async resolveSwaps(swaps) {
        return { swaps, telemetry: { resolved: 0 } };
      },
    },
  }, { owner: 'test-owner', maxBlocks: 50 });
  assert.equal(result.status, 'projected');
  assert.equal(result.toBlock, '149');
  assert.equal(committed.positions[0].quantityRaw, '10');
  assert.equal(committed.positions[0].costBasisUsd, '5');
  assert.equal(committed.positions[0].throughBlock, '120');
});

test('releases a claimed range for retry when its checkpoint diverges', async () => {
  let retry;
  const result = await runRobinhoodWalletPositionTokenRepairRange({
    coverage: {
      async claim() {
        return { tokenAddress: TOKEN, nextBlock: '100', sourceThroughBlock: '100' };
      },
      async commitShadowRange() { throw new Error('unexpected commit'); },
      async retry(input) { retry = input; return 'pending'; },
    },
    tickDeps: { evidence: { async matchesCheckpoint() { return false; } } },
    async prepareRange() {
      return { captured: { checkpoint: { number: '100', hash: HASH } }, classified: {} };
    },
    positions: { readUnifiedRangeSwaps() {}, loadPositions() {} },
    transactionPositions: { resolveSwaps() {} },
  }, { owner: 'test-owner' });
  assert.equal(result.status, 'pending');
  assert.equal(result.error.code, 'position_token_repair_checkpoint_mismatch');
  assert.equal(retry.tokenAddress, TOKEN);
});
