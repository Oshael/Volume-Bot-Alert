'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodWalletSwapOutboxRepository,
} = require('../src/models/robinhood-wallet-swap-outbox');
const {
  backoffFor, createRobinhoodWalletSwapOutboxRunner,
} = require('../src/services/robinhood-wallet-swap-outbox-runner');

const TX = `0x${'1'.repeat(64)}`;
const BLOCK_HASH = `0x${'2'.repeat(64)}`;

function claimed(overrides = {}) {
  const payload = {
    walletAddress: `0x${'3'.repeat(40)}`,
    transactionHash: TX,
    actionIndex: '7',
    blockNumber: '100',
    blockHash: BLOCK_HASH,
    transactionIndex: '2',
    blockTime: '2026-09-10T10:00:00.000Z',
    protocol: 'uniswap-v3',
    marketKey: `0x${'4'.repeat(40)}`,
    tokenAddress: `0x${'5'.repeat(40)}`,
    quoteAddress: `0x${'6'.repeat(40)}`,
    side: 'buy',
    tokenAmountRaw: '10',
    quoteAmountRaw: '20',
    parserVersion: 'rh-wallet-outbox-1',
  };
  return {
    transactionHash: TX, logIndex: '7', blockNumber: '100',
    blockHash: BLOCK_HASH, transactionIndex: '2', attemptCount: 2,
    payload, ...overrides,
  };
}

function fixture(input = {}) {
  const calls = [];
  let settlement = null;
  const repository = {
    reclaimExpired: async () => 1,
    claimFinalized: async (options) => {
      calls.push(['claim', options]);
      return input.rows || [claimed()];
    },
    settle: async (options) => {
      calls.push(['settle']);
      settlement = options;
      return input.settled || {
        delivered: options.delivered.length,
        retried: options.retry.length,
        blocked: 0,
      };
    },
  };
  const runner = createRobinhoodWalletSwapOutboxRunner({
    repository,
    readFinalizedBlock: async () => input.finalizedBlock === undefined
      ? '120' : input.finalizedBlock,
    transactionPositionRepository: {
      upsertPositions: async (rows) => {
        calls.push(['positions', rows]);
        if (input.persistenceError) throw input.persistenceError;
      },
    },
    walletRepository: {
      insertWalletSwaps: async (rows) => {
        calls.push(['swaps', rows]);
        return { inserted: input.inserted ?? rows.length };
      },
    },
    publishRows: async (rows) => {
      calls.push(['publish', rows]);
      if (input.publishError) throw input.publishError;
      return true;
    },
    options: { owner: 'test-owner', baseBackoffMs: 1000, maxBackoffMs: 300000 },
  });
  return { calls, getSettlement: () => settlement, runner };
}

describe('Robinhood wallet-swap durable outbox', () => {
  it('claims only canonical finalized rows in stable on-chain order', async () => {
    const queries = [];
    const database = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [
          {
            transaction_hash: `0x${'a'.repeat(64)}`, log_index: '9',
            block_number: '101', block_hash: BLOCK_HASH, transaction_index: '0',
            payload: {}, attempt_count: 1,
          },
          {
            transaction_hash: TX, log_index: '7', block_number: '100',
            block_hash: BLOCK_HASH, transaction_index: '2', payload: {}, attempt_count: 2,
          },
        ] };
      },
    };
    const repository = createRobinhoodWalletSwapOutboxRepository({ database });
    const rows = await repository.claimFinalized({
      owner: 'owner', limit: 20, leaseMs: 60000, throughBlock: '120',
    });

    assert.deepEqual(rows.map((row) => row.blockNumber), ['100', '101']);
    assert.deepEqual(queries[0].params, ['owner', 20, 60000, '120']);
    assert.match(queries[0].sql, /block\.canonical/);
    assert.match(queries[0].sql, /outbox\.block_number <= \$4::bigint/);
    assert.match(queries[0].sql, /FOR UPDATE OF outbox SKIP LOCKED/);
  });

  it('persists position and swap before publishing and deleting the leased row', async () => {
    const state = fixture();
    const result = await state.runner.runOnce();

    assert.deepEqual(state.calls.map(([name]) => name), [
      'claim', 'positions', 'swaps', 'publish', 'settle',
    ]);
    assert.equal(state.calls[0][1].throughBlock, '120');
    assert.equal(state.getSettlement().delivered.length, 1);
    assert.equal(state.getSettlement().retry.length, 0);
    assert.deepEqual(result, {
      status: 'delivered', throughBlock: '120', reclaimed: 1, claimed: 1, inserted: 1,
      delivered: 1, retried: 0, blocked: 0,
    });
  });

  it('retries idempotent persistence when publication fails after the writes', async () => {
    const state = fixture({ publishError: new Error('notify unavailable') });
    const result = await state.runner.runOnce();

    assert.deepEqual(state.calls.map(([name]) => name), [
      'claim', 'positions', 'swaps', 'publish', 'settle',
    ]);
    assert.equal(state.getSettlement().delivered.length, 0);
    assert.equal(state.getSettlement().retry[0].backoffMs, backoffFor(2, 1000, 300000));
    assert.equal(result.status, 'retrying');
    assert.equal(result.inserted, 1);
  });

  it('isolates a corrupt payload without writing or publishing it', async () => {
    const row = claimed();
    row.payload = { ...row.payload, blockHash: `0x${'f'.repeat(64)}` };
    const state = fixture({ rows: [row] });
    const result = await state.runner.runOnce();

    assert.deepEqual(state.calls.map(([name]) => name), ['claim', 'settle']);
    assert.match(state.getSettlement().retry[0].error, /identity mismatch/);
    assert.equal(result.status, 'retrying');
  });

  it('does not claim before a finality frontier exists', async () => {
    const state = fixture({ finalizedBlock: null });
    const result = await state.runner.runOnce();

    assert.equal(result.status, 'waiting-finality');
    assert.deepEqual(state.calls, []);
  });
});
