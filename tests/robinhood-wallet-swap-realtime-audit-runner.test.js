'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  backoffFor, createRobinhoodWalletSwapRealtimeAuditRunner,
  __private: { validateAuditClaim },
} = require('../src/services/robinhood-wallet-swap-realtime-audit-runner');

const TX = `0x${'1'.repeat(64)}`;
const BLOCK = `0x${'2'.repeat(64)}`;

function claimed(eventKind = 'observed', overrides = {}) {
  const contract = {
    observed: ['market:trade:observed', 'observed', 'observedAt'],
    finalized: ['market:trade:finalized', 'finalized', 'finalizedAt'],
    invalidate: ['market:trade:invalidate', 'invalidated', 'invalidatedAt'],
  }[eventKind];
  const payload = {
    protocolVersion: 2, type: contract[0], finality: contract[1],
    transactionHash: TX, actionIndex: '7', blockNumber: '100', asOfBlock: '100',
    blockHash: BLOCK, asOfBlockHash: BLOCK, transactionIndex: '2',
    blockTime: '2026-09-10T10:00:00Z', observedAt: '2026-09-10T10:00:00.1Z',
    walletAddress: `0x${'3'.repeat(40)}`, tokenAddress: `0x${'4'.repeat(40)}`,
    quoteAddress: `0x${'5'.repeat(40)}`, side: 'buy', protocol: 'uniswap-v3',
    marketKey: `0x${'6'.repeat(40)}`, volumeUsd: '10', priceUsd: '2', fdvUsd: '20',
    [contract[2]]: '2026-09-10T10:00:00.2Z',
    ...(eventKind === 'invalidate' ? { reason: 'reorg' } : {}),
  };
  return {
    transactionHash: TX, logIndex: '7', blockNumber: '100', blockHash: BLOCK,
    transactionIndex: '2', eventKind, attemptCount: 2, payload, ...overrides,
  };
}

function fixture(rows, settled = null) {
  const calls = [];
  let claimInput;
  let settlement;
  const repository = {
    reclaimExpiredAuditLeases: async () => { calls.push('reclaim'); return 1; },
    claimAudit: async (input) => { calls.push('claim'); claimInput = input; return rows; },
    settleAudit: async (input) => {
      calls.push('settle');
      settlement = input;
      return settled || {
        audited: input.audited.length, retried: input.retry.length, blocked: 0,
      };
    },
  };
  const runner = createRobinhoodWalletSwapRealtimeAuditRunner({
    repository,
    options: { owner: 'audit-test', batchSize: 3, baseBackoffMs: 1000 },
  });
  return { calls, getClaimInput: () => claimInput, getSettlement: () => settlement, runner };
}

describe('Robinhood wallet-swap realtime shadow audit', () => {
  it('accepts every lifecycle payload without a publisher dependency', async () => {
    const rows = ['observed', 'finalized', 'invalidate'].map((kind) => claimed(kind));
    for (const row of rows) assert.equal(validateAuditClaim(row), row.payload);
    const state = fixture(rows);
    const result = await state.runner.runOnce({ fromBlock: '123' });

    assert.deepEqual(state.calls, ['reclaim', 'claim', 'settle']);
    assert.equal(state.getClaimInput().fromBlock, '123');
    assert.equal(state.getSettlement().audited.length, 3);
    assert.equal(state.getSettlement().retry.length, 0);
    assert.deepEqual(result, {
      status: 'audited', reclaimed: 1, claimed: 3, saturated: true,
      audited: 3, retried: 0, blocked: 0,
    });
  });

  it('retries a corrupt payload with bounded exponential backoff', async () => {
    const row = claimed('observed');
    row.payload.asOfBlockHash = `0x${'f'.repeat(64)}`;
    const state = fixture([row]);
    const result = await state.runner.runOnce();

    assert.equal(state.getSettlement().audited.length, 0);
    assert.match(state.getSettlement().retry[0].error, /contract mismatch/);
    assert.equal(state.getSettlement().retry[0].backoffMs, backoffFor(2, 1000, 300000));
    assert.equal(result.status, 'retrying');
  });

  it('reports an idle reconciliation without settling', async () => {
    const state = fixture([]);
    assert.deepEqual(await state.runner.runOnce(), {
      status: 'idle', reclaimed: 1, claimed: 0, audited: 0, retried: 0, blocked: 0,
    });
    assert.deepEqual(state.calls, ['reclaim', 'claim']);
  });
});
