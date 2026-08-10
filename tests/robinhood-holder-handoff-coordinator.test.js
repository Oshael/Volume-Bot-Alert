const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderHandoffCoordinator,
} = require('../src/services/robinhood-holder-handoff-coordinator');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function candidate() {
  return {
    tokenAddress: TOKEN, backfillNextBlock: '105',
    checkpoint: { number: '104', hash: HASH }, version: 7,
  };
}

describe('Robinhood holder handoff coordinator', () => {
  it('promotes one RPC-verified candidate from a retained barrier', async () => {
    const calls = [];
    const repository = {
      getNextCandidate: async () => candidate(),
      markResyncing: async () => { throw new Error('unexpected isolation'); },
      promoteAtLiveBarrier: async (input) => {
        calls.push(['promote', input]);
        return { status: 'shadow', tokenAddress: TOKEN };
      },
    };
    const reader = {
      matchesCheckpoint: async (checkpoint) => {
        calls.push(['checkpoint', checkpoint]);
        return true;
      },
    };

    assert.deepEqual(await createRobinhoodHolderHandoffCoordinator({
      repository, reader,
    }).runOnce(), { status: 'shadow', tokenAddress: TOKEN });
    assert.deepEqual(calls, [
      ['checkpoint', { number: '104', hash: HASH }],
      ['promote', {
        tokenAddress: TOKEN, verifiedCheckpoint: { number: '104', hash: HASH },
      }],
    ]);
  });

  it('isolates an orphaned candidate and remains idle without work', async () => {
    const isolated = [];
    const repository = {
      getNextCandidate: async () => candidate(),
      promoteAtLiveBarrier: async () => { throw new Error('unexpected promotion'); },
      markResyncing: async (input) => {
        isolated.push(input);
        return { status: 'resyncing', tokenAddress: TOKEN };
      },
    };
    const coordinator = createRobinhoodHolderHandoffCoordinator({
      repository, reader: { matchesCheckpoint: async () => false },
    });
    assert.deepEqual(await coordinator.runOnce(), {
      status: 'resyncing', tokenAddress: TOKEN,
      reason: 'holder_handoff_checkpoint_orphaned',
    });
    assert.deepEqual(isolated, [candidate()]);

    repository.getNextCandidate = async () => null;
    assert.deepEqual(await coordinator.runOnce(), { status: 'idle' });
  });
});
