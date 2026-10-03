'use strict';

process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { CONFIRM_FLAG, main, parseArgs, readPage } = require('../src/utils/repair-robinhood-holder-frontier-anchors');
const HASH = `0x${'a'.repeat(64)}`;
const FORK = `0x${'b'.repeat(64)}`;
const RAW_HASH = `0x${'c'.repeat(64)}`;
const CHECKPOINT_HASH = `0x${'d'.repeat(64)}`;
const TIME = '2026-10-01T00:00:00.000Z';
const token = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const APPLY = ['--apply', CONFIRM_FLAG];
before(() => assertUsingTestDatabase(db));
after(() => db.pool.end());

async function fixture(action) {
  const client = await db.getClient();
  let savepoint = 0;
  let beforeInsert;
  const database = { getClient: async () => {
    let active;
    return { release() {}, async query(sql, params) {
      if (sql.startsWith('BEGIN')) {
        active = `repair_${savepoint += 1}`;
        return client.query(`SAVEPOINT ${active}`);
      }
      if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${active}`);
      if (sql === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${active}`);
      if (beforeInsert && sql.startsWith('INSERT INTO robinhood_chain_block_anchors')) {
        const callback = beforeInsert; beforeInsert = null; await callback();
      }
      return client.query(sql, params);
    } };
  } };
  try {
    await client.query('BEGIN');
    for (const table of ['robinhood_holder_token_states',
      'robinhood_holder_legacy_coverage_manifest', 'robinhood_chain_capture_cursor',
      'robinhood_chain_blocks', 'robinhood_chain_block_anchors', 'robinhood_chain_recoveries']) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query(`INSERT INTO robinhood_chain_capture_cursor
      (chain,next_block,checkpoint_block,checkpoint_hash) VALUES ('robinhood',101,100,$1)`, [CHECKPOINT_HASH]);
    for (let n = 1; n <= 6; n += 1) {
      const number = n === 5 ? 60 : n === 6 ? 101 : 50;
      await client.query(`INSERT INTO robinhood_holder_token_states
        (token_address,ledger_status,coverage_generation,deployment_block,backfill_next_block,live_through_block,
          live_through_hash,tail_capture_from_block)
        VALUES ($1,'live',$2,0,$3::bigint+1,$3,$4,$5)`, [token(n), n === 3 ? 2 : 1,
      number, n === 5 ? RAW_HASH : HASH, n === 4 ? 20 : null]);
      await client.query(`INSERT INTO robinhood_holder_legacy_coverage_manifest
        (chain,token_address,coverage_generation,baseline_status,baseline_deployment_block,
          baseline_backfill_next_block,baseline_live_through_block,baseline_live_through_hash,
          baseline_holder_count) VALUES ('robinhood',$1,1,'live',0,$2,$3,$4,0)`,
      [token(n), number + 1, number, n === 5 ? RAW_HASH : HASH]);
    }
    const raw = (number, hash, canonical = true) => client.query(`INSERT INTO robinhood_chain_blocks
      (chain,block_number,block_hash,parent_hash,capture_digest,block_timestamp,
        canonical,head_observed_at,receipts_available_at)
      VALUES ('robinhood',$1,$2,$2,$2,$3,$4,$3,$3)`, [number, hash, TIME, canonical]);
    await raw(60, RAW_HASH);
    const calls = [];
    const resolveBlock = async (number, hash) => {
      calls.push([number, hash]); return { blockNumber: number, blockHash: hash, blockTime: TIME };
    };
    const deps = { database, resolveBlock, logger: { log() {} } };
    await action({ client, database, calls, deps, raw,
      injectBeforeInsert(callback) { beforeInsert = callback; } });
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
}

it('repairs a shared legacy header once, with read-only preview and unchanged holder state', async () => {
  await fixture(async ({ client, database, calls, deps }) => {
    const states = async () => (await client.query(`SELECT token_address,
      coverage_generation::text,live_through_block::text,live_through_hash
      FROM robinhood_holder_token_states ORDER BY token_address`)).rows;
    const before = await states();
    const page = await readPage(database, parseArgs(['--scan-limit=1']));
    assert.equal(page.nextToken, token(1));
    assert.equal(page.exhausted, false);
    assert.equal((await readPage(database, parseArgs([
      '--scan-limit=1', `--after-token=${page.nextToken}`,
    ]))).nextToken, token(2));
    const preview = await main([], deps);
    assert.equal(preview.scanned, 3, 'stale manifests, tracked tails and future frontiers are excluded');
    assert.equal(preview.distinctAnchors, 1);
    assert.equal(preview.outcomes[0].sampledTokens, 2);
    assert.equal(preview.outcomes[0].status, 'verified');
    assert.deepEqual(calls, [['100', CHECKPOINT_HASH], ['50', HASH]]);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_block_anchors')).rows[0].n, 0);
    assert.equal((await main(APPLY, deps)).outcomes[0].status, 'repaired');
    assert.equal((await main(APPLY, deps)).outcomes[0].status, 'already_present');
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_block_anchors')).rows[0].n, 1);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_blocks')).rows[0].n, 1);
    assert.deepEqual(await states(), before);
  });
});

for (const [name, change, status, code] of [
  ['recovery activated', `UPDATE robinhood_chain_capture_cursor SET
    recovery_state='recovery_required',recovery_plan='{}'::jsonb,recovery_detected_at=NOW()`,
    'unresolved', 'canonical_projection_fence_conflict'],
  ['recovery completed in another generation', 'UPDATE robinhood_chain_capture_cursor SET generation=1',
    'unresolved', 'holder_anchor_generation_changed'],
  ['holder frontier changed', `UPDATE robinhood_holder_token_states SET live_through_block=51,live_through_hash='${FORK}'
    WHERE token_address='${token(1)}'`, 'stale', undefined],
  ['manifest invalidated', `UPDATE robinhood_holder_legacy_coverage_manifest SET coverage_generation=0
    WHERE token_address='${token(1)}'`, 'stale', undefined],
]) {
  it(`does not persist evidence when ${name} during RPC verification`, async () => {
    await fixture(async ({ client, deps }) => {
      const resolve = deps.resolveBlock;
      deps.resolveBlock = async (number, hash) => {
        if (number === '50') await client.query(change);
        return resolve(number, hash);
      };
      const outcome = (await main(APPLY, deps)).outcomes[0];
      assert.equal(outcome.status, status);
      assert.equal(outcome.code, code);
      assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_block_anchors')).rows[0].n, 0);
    });
  });
}

for (const name of ['canonical fork', 'orphaned hash', 'ambiguous durable hash', 'divergent timestamp']) {
  it(`refuses a ${name} without replacing local evidence`, async () => {
    await fixture(async ({ client, deps, raw }) => {
      if (name === 'canonical fork') await raw(50, FORK);
      else if (name === 'orphaned hash') await raw(50, HASH, false);
      else await client.query(`INSERT INTO robinhood_chain_block_anchors
        (chain,block_number,block_hash,block_timestamp) VALUES ('robinhood',50,$1,$2)`,
      [name === 'ambiguous durable hash' ? FORK : HASH, name === 'divergent timestamp' ? '2026-10-02T00:00:00Z' : TIME]);
      const before = (await client.query('SELECT block_number::text,block_hash,block_timestamp FROM robinhood_chain_block_anchors')).rows;
      assert.equal((await main(APPLY, deps)).outcomes[0].code, 'holder_anchor_local_conflict');
      assert.deepEqual((await client.query('SELECT block_number::text,block_hash,block_timestamp FROM robinhood_chain_block_anchors')).rows, before);
    });
  });
}

it('fails before writes on RPC disagreement and omits provider secrets from outcomes', async () => {
  await fixture(async ({ client, deps }) => {
    deps.resolveBlock = async () => { throw new Error('secret https://rpc.example/private-key'); };
    await assert.rejects(main(APPLY, deps));
    deps.resolveBlock = async (number, hash) => {
      if (number === '50') throw new Error('secret https://rpc.example/private-key');
      return { blockNumber: number, blockHash: hash, blockTime: TIME };
    };
    const report = await main(APPLY, deps);
    assert.equal(report.outcomes[0].status, 'unresolved');
    assert.doesNotMatch(JSON.stringify(report), /secret|private-key|rpc\.example/);
    deps.resolveBlock = async (number, hash) => ({
      blockNumber: number, blockHash: number === '50' ? FORK : hash, blockTime: TIME,
    });
    assert.equal((await main([], deps)).outcomes[0].status, 'unresolved');
    assert.equal((await main(APPLY, deps)).outcomes[0].status, 'unresolved');
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_block_anchors')).rows[0].n, 0);
  });
});

it('rejects conflicting evidence inserted after validation instead of reporting it as already present', async () => {
  await fixture(async ({ client, deps, injectBeforeInsert }) => {
    injectBeforeInsert(() => client.query(`INSERT INTO robinhood_chain_block_anchors
      (chain,block_number,block_hash,block_timestamp)
      VALUES ('robinhood',50,$1,'2026-10-02T00:00:00Z')`, [HASH]));
    const outcome = (await main(APPLY, deps)).outcomes[0];
    assert.equal(outcome.status, 'unresolved');
    assert.equal(outcome.code, 'holder_anchor_local_conflict');
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_block_anchors')).rows[0].n, 0);
  });
});
