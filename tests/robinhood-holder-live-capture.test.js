const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodHolderLiveCapture } = require('../src/services/robinhood-holder-live-capture');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

describe('Robinhood holder global live capture', () => {
  it('captures one confirmed global range with optimistic cursor continuity', async () => {
    const calls = [];
    const ledger = {
      getCursor: async () => ({
        nextBlock: '103', checkpointBlock: '102', checkpointHash: HASH, version: 4,
      }),
      listTrackedTokenAddresses: async () => [TOKEN],
      appendCapturedRange: async (input) => {
        calls.push(['append', input]);
        return { insertedTransfers: 1, duplicateTransfers: 0, cursorVersion: 5 };
      },
    };
    const transfer = { tokenAddress: TOKEN };
    const reader = {
      getSafeHead: async (confirmations) => {
        calls.push(['head', confirmations]);
        return { head: '117', safeHead: '105', confirmations };
      },
      matchesCheckpoint: async (checkpoint) => {
        calls.push(['checkpoint', checkpoint]);
        return true;
      },
      readGlobalRange: async (input) => {
        calls.push(['read', input]);
        return {
          fromBlock: '103', toBlock: '105', nextBlock: '106', scopeTokens: 1,
          checkpoint: { number: '105', hash: HASH }, transfers: [transfer],
          telemetry: { requests: 1, splits: 0, observedLogs: 2, ignoredLogs: 1 },
        };
      },
    };
    const result = await createRobinhoodHolderLiveCapture({ ledger, reader }).captureOnce();

    assert.equal(result.status, 'captured');
    assert.equal(result.cursorVersion, 5);
    assert.deepEqual(calls, [
      ['head', 12],
      ['checkpoint', { number: '102', hash: HASH }],
      ['read', { tokenAddresses: [TOKEN], fromBlock: '103', toBlock: '105' }],
      ['append', {
        transfers: [transfer],
        cursor: {
          rangeStart: '103', nextBlock: '106', safeHead: '105', expectedVersion: 4,
          checkpoint: { number: '105', hash: HASH },
        },
      }],
    ]);
  });

  it('initializes at safe head and fails closed when a persisted checkpoint is orphaned', async () => {
    const appended = [];
    const reader = {
      getSafeHead: async () => ({ head: '112', safeHead: '100', confirmations: 12 }),
      matchesCheckpoint: async () => false,
      readGlobalRange: async (input) => ({
        ...input, nextBlock: '101', scopeTokens: 0,
        checkpoint: { number: '100', hash: HASH }, transfers: [],
        telemetry: { requests: 0, splits: 0, observedLogs: 0, ignoredLogs: 0 },
      }),
    };
    const initialLedger = {
      getCursor: async () => null,
      listTrackedTokenAddresses: async () => [],
      appendCapturedRange: async (input) => {
        appended.push(input);
        return { insertedTransfers: 0, duplicateTransfers: 0, cursorVersion: 0 };
      },
    };
    const initialized = await createRobinhoodHolderLiveCapture({
      ledger: initialLedger, reader,
    }).captureOnce();
    assert.deepEqual([initialized.fromBlock, initialized.toBlock], ['100', '100']);
    assert.equal(appended[0].cursor.expectedVersion, null);

    const orphaned = await createRobinhoodHolderLiveCapture({
      ledger: { ...initialLedger, getCursor: async () => ({
        nextBlock: '101', checkpointBlock: '100', checkpointHash: HASH, version: 0,
      }) },
      reader,
    }).captureOnce();
    assert.deepEqual(orphaned, {
      status: 'reorg-detected', nextBlock: '101', checkpointBlock: '100', cursorVersion: 0,
    });
    assert.equal(appended.length, 1);
  });
});
