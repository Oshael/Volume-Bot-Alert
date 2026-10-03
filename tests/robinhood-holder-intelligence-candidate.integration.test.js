process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodHolderIntelligenceCandidateRepository } = require('../src/models/robinhood-holder-intelligence-candidate');
const { createRobinhoodHolderIntelligenceWorker } = require('../src/services/robinhood-holder-intelligence-worker');
const token = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const HASH = `0x${'a'.repeat(64)}`;
const FORK = `0x${'b'.repeat(64)}`;
after(() => db.pool.end());

it('advances past blocked frontiers and retries unchanged/failing tokens without starving peers', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['robinhood_holder_token_states',
      'robinhood_holder_classification_states', 'robinhood_holder_distribution_metrics']) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, canonical boolean
    )`);
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES ('robinhood',100,$1,true)`, [HASH]);
    for (let n = 1; n <= 13; n += 1) {
      await client.query(`INSERT INTO robinhood_holder_token_states
        (token_address,ledger_status,live_through_block,live_through_hash)
        VALUES ($1,'live',$2,$3)`, [token(n), n <= 6 ? 50 : 100, n === 7 ? FORK : HASH]);
    }
    const repository = createRobinhoodHolderIntelligenceCandidateRepository({ database: client });
    assert.deepEqual(await repository.listCandidates({ limit: 1 }), [],
      'an unanchored oldest token must not occupy the candidate batch');
    let afterToken = null;
    const selected = [];
    for (let i = 0; i < 20; i += 1) {
      const page = await repository.listCandidatePage({ limit: 1, afterToken });
      assert.ok(page.scanned <= 5);
      selected.push(...page.candidates.map((candidate) => candidate.tokenAddress));
      if (page.exhausted) break;
      assert.ok(page.nextToken > (afterToken || ''));
      afterToken = page.nextToken;
    }
    assert.deepEqual(selected, [8, 9, 10, 11, 12, 13].map(token),
      'truncating a page must not skip the other eligible candidates');
    let clock = 0;
    const attempts = [];
    const worker = createRobinhoodHolderIntelligenceWorker({
      now: () => clock, candidates: repository,
      materializers: [{ async materializeToken(address) {
        attempts.push(address);
        if (address === token(8)) throw Object.assign(new Error('frontier changed'), {
          code: 'canonical_projection_fence_conflict',
        });
        return { status: address === token(9) ? 'unchanged' : 'published' };
      } }],
    });
    // More than two full scans of the fixture, without elapsed retry time.
    for (let i = 0; i < 8; i += 1) await worker.runOnce();
    assert.equal(attempts.filter((address) => address === token(8)).length, 1);
    assert.equal(attempts.filter((address) => address === token(9)).length, 1);
    assert.ok(attempts.includes(token(13)), 'partial failures must not hold up later tokens');
    assert.ok(worker.getStatus().totalRetryDeferred > 0);
    // A new committed frontier can be attempted immediately, including a changed hash.
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES ('robinhood',101,$1,true)`, [FORK]);
    await client.query(`UPDATE robinhood_holder_token_states SET
      live_through_block=101,live_through_hash=$2 WHERE token_address=$1`, [token(8), FORK]);
    for (let i = 0; i < 3; i += 1) await worker.runOnce();
    assert.equal(attempts.filter((address) => address === token(8)).length, 2);
    clock = 3_600_000;
    for (let i = 0; i < 3; i += 1) await worker.runOnce();
    assert.ok(attempts.filter((address) => address === token(9)).length >= 2);
    await worker.stop();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
