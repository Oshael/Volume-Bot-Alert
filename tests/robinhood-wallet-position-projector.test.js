const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodWalletPositionRepository } = require('../src/models/robinhood-wallet-position');
const {
  createRobinhoodWalletPositionProjector,
} = require('../src/services/robinhood-wallet-position-projector');
const stage127 = require('../src/utils/db-init-stage127');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const TOKEN = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const TX_A = `0x${'aa'.repeat(32)}`;
const TX_B = `0x${'bb'.repeat(32)}`;
const TIME = '2026-08-01T00:00:00.000Z';

function swap(overrides = {}) {
  return {
    token_address: TOKEN, wallet_address: WALLET, transaction_hash: TX_A,
    action_index: '1', block_number: '10', side: 'buy', token_amount_raw: '10',
    volume_usd: '10', market_cap_usd: '100', ...overrides,
  };
}

function fakeRepository() {
  const calls = [];
  return {
    calls,
    async loadCursor() {
      return {
        projectionVersion: 'swap_only_v1', stream: 'seed', nextBlock: '10',
        safeHead: '20', nextBlockTime: TIME, version: 0,
      };
    },
    async readSwapBatch() {
      return {
        nextBlock: '12', nextBlockTime: TIME,
        swaps: [
          swap(),
          swap({ action_index: '2', token_amount_raw: '20', volume_usd: '20', market_cap_usd: '200' }),
          swap({ transaction_hash: TX_B, action_index: '3', block_number: '11', side: 'sell', token_amount_raw: '5', volume_usd: '8', market_cap_usd: null }),
        ],
      };
    },
    async loadPositions() { return []; },
    async commitBatch(input) {
      calls.push(input);
      return { committed: true };
    },
  };
}

describe('Robinhood wallet position projector', () => {
  it('projects complete blocks, corrected MC and distinct side transactions', async () => {
    const repository = fakeRepository();
    const report = await createRobinhoodWalletPositionProjector({ repository }).runBatch({
      projectionVersion: 'swap_only_v1', commit: true,
    });

    assert.equal(report.swaps, 3);
    assert.equal(report.positions, 1);
    assert.equal(report.missingMarketCap, 1);
    const position = repository.calls[0].positions[0];
    assert.equal(position.buyTxCount, 1, 'two actions in one transaction count once');
    assert.equal(position.sellTxCount, 1);
    assert.equal(position.buyMcapWeightedSum, '5000');
    assert.equal(position.buyMcapWeightUsd, '30');
    assert.equal(position.quantityRaw, '25');
  });

  it('is dry-run by default and performs no persistence', async () => {
    const repository = fakeRepository();
    const report = await createRobinhoodWalletPositionProjector({ repository }).runBatch({});

    assert.equal(report.dryRun, true);
    assert.equal(repository.calls.length, 0);
  });

  it('reads only time-pruned partitions and joins the durable MC sidecar', async () => {
    const queries = [];
    const database = {
      async query(sql) {
        queries.push(sql);
        if (queries.length === 1) return { rows: [{ block_time: new Date(TIME), block_number: '10' }] };
        return { rows: [swap()] };
      },
    };
    const repository = createRobinhoodWalletPositionRepository({ database });
    const batch = await repository.readSwapBatch({
      fromBlock: '10', toBlock: '20', fromTime: TIME, maxBlocks: 10,
    });

    assert.match(queries[0], /block_time >= \$2::timestamptz/);
    assert.match(queries[1], /LEFT JOIN robinhood_swap_mc/);
    assert.match(queries[1], /ORDER BY swap\.block_time, swap\.block_number, swap\.action_index/);
    assert.equal(batch.nextBlock, '11');
  });

  it('registers the additive Stage 127 time frontier', () => {
    assert.match(stage127.STATEMENTS.join('\n'), /ADD COLUMN IF NOT EXISTS next_block_time/);
    assert.equal(SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage127-robinhood-wallet-position-time-frontier'
    )).repair, 'node src/utils/db-init-stage127.js');
  });
});
