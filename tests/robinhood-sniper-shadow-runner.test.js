const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodSniperShadowCandidateRepository,
} = require('../src/models/robinhood-sniper-shadow-candidate');
const {
  createRobinhoodSniperShadowRunner,
} = require('../src/services/robinhood-sniper-shadow-runner');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;

describe('Robinhood SNIPER shadow candidates', () => {
  it('pages only live tokens behind the shadow classifier after first-buy catch-up', async () => {
    const calls = [];
    const repository = createRobinhoodSniperShadowCandidateRepository({
      database: { query: async (...args) => {
        calls.push(args);
        return { rows: [{ token_address: TOKEN_B }] };
      } },
    });

    assert.deepEqual(await repository.listCandidates({
      limit: 5, retryMs: 60_000, afterToken: TOKEN_A.toUpperCase(),
    }), [TOKEN_B]);
    assert.deepEqual(calls[0][1], [
      'rh_holder_v1', 60_000, TOKEN_A, 5, 'rh_sniper_high_v2',
    ]);
    assert.match(calls[0][0], /robinhood_first_buy_live_cursors/);
    assert.match(calls[0][0], /cursor\.next_time = cursor\.source_through/);
    assert.match(calls[0][0], /state\.token_address > \$3/);
    assert.match(calls[0][0], /sniper\.classifier = 'sniper'/);
    await assert.rejects(repository.listCandidates({ limit: 101 }), /candidate limit/);
  });
});

describe('Robinhood SNIPER shadow runner', () => {
  it('materializes a bounded page and returns a resumable cursor', async () => {
    const calls = [];
    const runner = createRobinhoodSniperShadowRunner({
      candidates: { listCandidates: async (input) => {
        calls.push(['candidates', input]);
        return [TOKEN_A, TOKEN_B];
      } },
      materializer: { materializeTokens: async (tokenAddresses, options) => {
        calls.push(['materialize-batch', tokenAddresses, options]);
        return [
          { tokenAddress: TOKEN_A, status: 'completed' },
          { tokenAddress: TOKEN_B, status: 'deferred' },
        ];
      } },
    });

    assert.deepEqual(await runner.runBatch({
      limit: 2, concurrency: 2, retryMs: 60_000, afterToken: TOKEN_A,
    }), {
      mode: 'shadow', candidates: 2, completed: 1, deferred: 1, failed: 0,
      nextToken: TOKEN_B, exhausted: false,
    });
    assert.deepEqual(calls[0], ['candidates', {
      limit: 2, retryMs: 60_000, afterToken: TOKEN_A,
    }]);
    assert.deepEqual(calls[1], [
      'materialize-batch', [TOKEN_A, TOKEN_B], { concurrency: 2 },
    ]);
  });

  it('contains per-token failures and bounds controls', async () => {
    const runner = createRobinhoodSniperShadowRunner({
      candidates: { listCandidates: async () => [TOKEN_A] },
      materializer: { materializeToken: async () => { throw new Error('broken token'); } },
    });

    assert.deepEqual(await runner.runBatch(), {
      mode: 'shadow', candidates: 1, completed: 0, deferred: 0, failed: 1,
      nextToken: TOKEN_A, exhausted: true,
    });
    await assert.rejects(runner.runBatch({ concurrency: 5 }), /concurrency/);
  });
});
