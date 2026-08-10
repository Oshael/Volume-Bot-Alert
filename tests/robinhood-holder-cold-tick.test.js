const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodHolderColdTick,
  __private,
} = require('../src/services/robinhood-holder-cold-tick');
const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const CREATOR_A = `0x${'c'.repeat(40)}`;
const CREATOR_B = `0x${'d'.repeat(40)}`;
const TX_HASH = `0x${'e'.repeat(64)}`;
const CUTOFF = '2026-08-10T00:00:00.000Z';
const NOW = Date.parse('2026-08-10T12:00:00.000Z');

function runtime(overrides = {}) {
  const calls = [];
  const candidates = [
    { tokenAddress: TOKEN_A, creatorAddress: CREATOR_A },
    { tokenAddress: TOKEN_B, creatorAddress: CREATOR_B },
  ];
  const deps = {
    now: () => NOW,
    repository: {
      listHolderDirectVerificationCandidates: async (input) => {
        calls.push(['candidates', input]);
        return candidates;
      },
      recordDirectVerificationFailure: async (input) => {
        calls.push(['failure', input]);
        return { recorded: true };
      },
      recordVerifiedDirectDeployments: async (input) => {
        calls.push(['persist', input]);
        return { attributed: input.length };
      },
    },
    blockscoutClient: {
      getContractCreators: async (addresses) => {
        calls.push(['blockscout', addresses]);
        return [
          { tokenAddress: TOKEN_A, creatorAddress: CREATOR_A, transactionHash: TX_HASH },
          { tokenAddress: TOKEN_B, creatorAddress: CREATOR_B, transactionHash: null },
        ];
      },
    },
    requestScheduler: {
      schedule: async (task) => { calls.push(['schedule']); return task(); },
    },
    verifier: {
      verifyDirectDeployment: async (hint) => {
        calls.push(['verify', hint]);
        return { ...hint, source: 'rpc_direct', factoryAddress: null, blockNumber: '100' };
      },
    },
    bootstrap: {
      seedColdTokens: async (input) => {
        calls.push(['seed', input]);
        return [{ tokenAddress: TOKEN_A }];
      },
    },
    executor: {
      runOnce: async (input) => {
        calls.push(['replay', input]);
        return calls.filter(([name]) => name === 'replay').length === 1
          ? { status: 'idle' }
          : { status: 'committed', tokenAddress: TOKEN_A, atBarrier: false };
      },
    },
    ...overrides,
  };
  return { calls, deps };
}
describe('Robinhood holder cold tick', () => {
  it('throttles one hint batch, verifies serially, then seeds and replays once', async () => {
    const { calls, deps } = runtime();
    const result = await runRobinhoodHolderColdTick(deps, {
      admittedBefore: CUTOFF, candidateLimit: 2, retryMs: 86_400_000,
      rangeSize: 100, confirmations: 20,
    });

    assert.deepEqual(result, {
      candidates: 2, verified: 1, failed: 1, providerError: null,
      seededTokens: 1, replayStatus: 'committed', tokenAddress: TOKEN_A, atBarrier: false,
    });
    assert.deepEqual(calls[0], ['candidates', {
      admittedBefore: CUTOFF,
      retryBefore: '2026-08-09T12:00:00.000Z', limit: 2,
    }]);
    assert.deepEqual(calls.filter(([name]) => name === 'blockscout'), [
      ['blockscout', [TOKEN_A, TOKEN_B]],
    ]);
    assert.deepEqual(calls.find(([name]) => name === 'failure'), [
      'failure', { tokenAddress: TOKEN_B, error: 'holder_deployment_hint_incomplete' },
    ]);
    assert.deepEqual(calls.slice(-3), [
      ['replay', { rangeSize: 100, confirmations: 20 }],
      ['seed', { admittedBefore: CUTOFF, limit: 1 }],
      ['replay', { rangeSize: 100, confirmations: 20 }],
    ]);
  });

  it('does not admit another token while a backfill range is available', async () => {
    const { calls, deps } = runtime({
      executor: {
        runOnce: async (input) => {
          calls.push(['replay', input]);
          return { status: 'committed', tokenAddress: TOKEN_A, atBarrier: false };
        },
      },
    });
    const result = await runRobinhoodHolderColdTick(deps, { admittedBefore: CUTOFF });

    assert.equal(result.seededTokens, 0);
    assert.equal(calls.some(([name]) => name === 'seed'), false);
    assert.equal(calls.filter(([name]) => name === 'replay').length, 1);
  });

  it('continues existing exact replay when Blockscout is unavailable', async () => {
    const { deps } = runtime({
      requestScheduler: {
        schedule: async () => { throw Object.assign(new Error('open'), { code: 'circuit_open' }); },
      },
    });
    const result = await runRobinhoodHolderColdTick(deps, { admittedBefore: CUTOFF });

    assert.equal(result.providerError, 'circuit_open');
    assert.equal(result.verified, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.seededTokens, 1);
    assert.equal(result.replayStatus, 'committed');
  });

  it('fails closed on invalid configuration and verifier chain mismatch', async () => {
    const { deps } = runtime();
    assert.throws(
      () => __private.normalizeOptions({ admittedBefore: 'invalid' }),
      (error) => error.code === 'configuration_error'
    );
    deps.verifier.verifyDirectDeployment = async () => {
      throw Object.assign(new Error('wrong chain'), { code: 'configuration_error' });
    };
    await assert.rejects(
      () => runRobinhoodHolderColdTick(deps, { admittedBefore: CUTOFF }),
      (error) => error.code === 'configuration_error'
    );
  });
});
