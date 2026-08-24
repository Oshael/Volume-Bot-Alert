const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodDirectionalTransferReplayWriter,
} = require('../src/services/robinhood-directional-transfer-replay-writer');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;

function event(blockNumber, logIndex, transferKind = 'wallet_transfer') {
  return {
    tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB,
    blockNumber: String(blockNumber), logIndex, transferKind,
    blockTime: '2026-08-23T00:00:00.000Z', transactionHash: HASH, amountRaw: '10',
  };
}

function setup(overrides = {}) {
  const calls = [];
  const rangeDeps = {
    source: { async listTrackedTokenAddresses() { calls.push('tracked'); return [TOKEN]; } },
    evidence: { async matchesCheckpoint() { return overrides.canonical !== false; } },
  };
  const writer = createRobinhoodDirectionalTransferReplayWriter({
    rangeDeps,
    tokenScope: { async listRunTokenAddresses(runId) {
      calls.push(['frozen', runId]); return [TOKEN];
    } },
    repository: { async applyEvidence(input) {
      calls.push(input);
      return { edgesConsidered: input.events.length, edgesWritten: input.events.length };
    } },
    async prepareRange(_deps, input) {
      calls.push(input);
      if (overrides.outcome) return { outcome: overrides.outcome };
      return {
        captured: {
          fromBlock: input.fromBlock, toBlock: input.toBlock,
          checkpoint: { number: input.toBlock, hash: HASH },
          transfers: [event(101, 4), event(100, 2), event(100, 3, 'dex_flow')],
          telemetry: { requests: 2, evidenceBatches: 1 },
        },
        classified: { events: [event(101, 4), event(100, 2), event(100, 3, 'dex_flow')] },
      };
    },
  });
  return { calls, writer };
}

describe('Robinhood directional transfer replay writer', () => {
  it('probes without writing and materializes only the earliest direct event', async () => {
    const { calls, writer } = setup();
    const range = { runId: '7', rangeStartBlock: '100', rangeEndBlock: '101' };
    assert.deepEqual(await writer.probeRange(range), {
      checkpointCanonical: true, rpcRequests: 3, transfersScanned: 3, edgesConsidered: 1,
    });
    assert.equal(calls.filter((item) => typeof item === 'object' && item.events).length, 0);
    const result = await writer.materializeRange(range);
    const write = calls.find((item) => item.events);
    assert.equal(write.events[0].blockNumber, '100');
    assert.deepEqual(result, {
      completedThroughBlock: '101', completedThroughHash: HASH,
      blocksScanned: '2', transfersScanned: '3', edgesConsidered: '1', edgesWritten: '1',
    });
    assert.equal(calls.filter((item) => item === 'tracked').length, 1);
    assert.deepEqual(calls.find((item) => Array.isArray(item) && item[0] === 'frozen'),
      ['frozen', '7']);
  });

  it('fails closed for unavailable context and a non-canonical checkpoint', async () => {
    const range = { runId: '7', rangeStartBlock: '100', rangeEndBlock: '101' };
    await assert.rejects(setup().writer.materializeRange({
      rangeStartBlock: '100', rangeEndBlock: '101',
    }), /no frozen run scope/);
    await assert.rejects(
      setup({ outcome: { status: 'awaiting-context', reason: 'swap_gap' } }).writer.probeRange(range),
      (error) => error.code === 'directional_replay_source_unavailable'
    );
    await assert.rejects(
      setup({ canonical: false }).writer.materializeRange(range),
      (error) => error.code === 'directional_replay_checkpoint_mismatch'
    );
  });
});
