'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  runPumpProfileBackfill,
  __private: { CANDIDATES_SQL, parseArgs },
} = require('../src/utils/backfill-pump-callout-profiles');

const SOLANA = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';

function dependencies() {
  const commits = [];
  let requests = 0;
  return {
    commits,
    get requests() { return requests; },
    database: { query: async () => ({ rows: [{ platform_user_id: SOLANA }] }) },
    client: { getUserProfile: async () => {
      requests += 1;
      return { body: {
        userId: 'different-api-id', address: SOLANA, username: 'caller',
        profile_image: 'https://example.test/avatar.png', x_username: 'caller_x',
      } };
    } },
    repository: { commitCapture: async (input) => commits.push(input) },
    now: () => Date.parse('2026-08-25T12:00:00.000Z'),
  };
}

describe('Pump persisted profile backfill', () => {
  it('is bounded and dry-run by default without HTTP or persistence', async () => {
    const deps = dependencies();
    assert.deepEqual(parseArgs([]), {
      mode: 'dry-run', limit: 100, concurrency: 3, after: null,
    });
    assert.match(CANDIDATES_SQL, /platform = 'pump'/);
    assert.match(CANDIDATES_SQL, /username IS NULL/);

    assert.deepEqual(await runPumpProfileBackfill(parseArgs([]), deps), {
      mode: 'dry-run', candidates: 1, nextAfter: SOLANA,
      enriched: 0, failures: 0, errors: {},
    });
    assert.equal(deps.requests, 0);
    assert.deepEqual(deps.commits, []);
  });

  it('preserves the callout identity while atomically enriching profile and wallet', async () => {
    const deps = dependencies();
    const result = await runPumpProfileBackfill({
      mode: 'write', limit: 10, concurrency: 2, after: null,
    }, deps);

    assert.equal(result.enriched, 1);
    assert.equal(result.failures, 0);
    assert.equal(deps.commits.length, 1);
    const input = deps.commits[0];
    assert.equal(input.checkpointKey, 'pump:profile-enrichment');
    assert.equal(input.profileEnvelopes[0].payload.platformUserId, SOLANA);
    assert.equal(input.profileEnvelopes[0].payload.username, 'caller');
    assert.equal(input.profileEnvelopes[0].payload.profilePictureUrl,
      'https://example.test/avatar.png');
    assert.equal(input.profileEnvelopes[0].payload.wallets[0].address, SOLANA);
  });

  it('rejects unsafe modes and out-of-range controls fall back to safe defaults', () => {
    assert.throws(() => parseArgs(['--mode=unsafe']), /dry-run or write/);
    assert.deepEqual(parseArgs(['--limit=9999', '--concurrency=99', '--after=id']), {
      mode: 'dry-run', limit: 100, concurrency: 3, after: 'id',
    });
  });
});
