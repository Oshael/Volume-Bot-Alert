const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodInsiderShadowCandidateRepository,
} = require('../src/models/robinhood-insider-shadow-candidate');
const {
  createRobinhoodInsiderShadowRunner,
} = require('../src/services/robinhood-insider-shadow-runner');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;

describe('Robinhood INSIDER shadow runner', () => {
  it('selects a bounded page only after creator and transfer coverage are ready', async () => {
    const calls = [];
    const candidates = createRobinhoodInsiderShadowCandidateRepository({
      database: { query: async (...args) => {
        calls.push(args);
        return { rows: [{ token_address: TOKEN_B }] };
      } },
    });
    assert.deepEqual(await candidates.listCandidates({
      limit: 5, retryMs: 60_000, afterToken: TOKEN_A.toUpperCase(),
    }), [TOKEN_B]);
    assert.deepEqual(calls[0][1].slice(0, 4), ['rh_holder_v1', 'rh_transfer_v1', 60_000, TOKEN_A]);
    assert.match(calls[0][0], /robinhood_token_attributions/);
    assert.match(calls[0][0], /cursor\.next_block > state\.live_through_block/);
    assert.match(calls[0][0], /replay\.status = 'completed'/);
    assert.match(calls[0][0], /insider\.classifier = 'insider'/);
    assert.match(calls[0][0], /state\.token_address > \$4/);
    await assert.rejects(candidates.listCandidates({ limit: 101 }), /candidate limit/);
  });

  it('materializes concurrently, contains token failures, and returns its cursor', async () => {
    const calls = [];
    const runner = createRobinhoodInsiderShadowRunner({
      candidates: { listCandidates: async (input) => {
        calls.push(input); return [TOKEN_A, TOKEN_B];
      } },
      materializer: { materializeToken: async (token) => {
        if (token === TOKEN_B) throw new Error('broken token');
        return { status: 'replaced' };
      } },
    });
    assert.deepEqual(await runner.runBatch({ limit: 2, concurrency: 2, retryMs: 60_000 }), {
      mode: 'shadow', candidates: 2, completed: 1, deferred: 0, failed: 1,
      nextToken: TOKEN_B, exhausted: false,
    });
    assert.deepEqual(calls[0], { limit: 2, retryMs: 60_000, afterToken: null });
    await assert.rejects(runner.runBatch({ concurrency: 5 }), /concurrency/);
  });
});
