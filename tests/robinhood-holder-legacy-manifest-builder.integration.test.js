'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage232 = require('../src/utils/db-init-stage232');
const stage233 = require('../src/utils/db-init-stage233');
const {
  createRobinhoodHolderLegacyManifestBuilder,
} = require('../src/services/robinhood-holder-legacy-manifest-builder');

const TOKEN = `0x${'f'.repeat(40)}`;
const OLD_TOKEN = `0x${'f'.repeat(39)}e`;
const BEFORE_TOKEN = `0x${'f'.repeat(39)}d`;
const HASH = `0x${'a'.repeat(64)}`;
const TOKENS = [OLD_TOKEN, TOKEN];

after(() => db.pool.end());

it('builds generation zero idempotently and rejects a concurrent reset generation', async () => {
  await stage232.init({ database: db, closePool: false });
  await stage233.init({ database: db, closePool: false });
  const client = await db.getClient();
  let savepoint = 0;
  const database = { async getClient() {
    let active;
    return {
      async query(sql, params) {
        if (sql.startsWith('BEGIN')) {
          active = `builder_${savepoint += 1}`;
          return client.query(`SAVEPOINT ${active}`);
        }
        if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${active}`);
        if (sql === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${active}`);
        return client.query(sql, params);
      },
      release() {},
    };
  } };
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO robinhood_holder_cursors (
      chain,stream,next_block,safe_head,checkpoint_block,checkpoint_hash,
      journal_floor_block,buffer_floor_block
    ) VALUES ('robinhood','live',200,199,199,$1,90,90)
    ON CONFLICT (chain,stream) DO UPDATE SET next_block=200,safe_head=199,
      checkpoint_block=199,checkpoint_hash=$1,journal_floor_block=90,buffer_floor_block=90`,
    [HASH]);
    let rawFloor = (await client.query(`SELECT MIN(block_number) AS value
      FROM robinhood_chain_blocks WHERE chain='robinhood' AND canonical=TRUE`)).rows[0].value;
    if (rawFloor == null) {
      await client.query(`INSERT INTO robinhood_chain_blocks (
        chain,block_number,block_hash,parent_hash,capture_digest,block_timestamp,
        canonical,head_observed_at,receipts_available_at
      ) VALUES ('robinhood',100,$1,$2,$3,NOW(),TRUE,NOW(),NOW())`,
      [`0x${'b'.repeat(64)}`, `0x${'c'.repeat(64)}`, `0x${'d'.repeat(64)}`]);
      rawFloor = '100';
    }
    assert.ok(BigInt(rawFloor) > 0n);
    const oldBlock = (BigInt(rawFloor) - 1n).toString();
    const nextBlock = (BigInt(rawFloor) + 100n).toString();
    await client.query(`UPDATE robinhood_holder_cursors SET next_block=$1,
      safe_head=$1::bigint-1,checkpoint_block=$1::bigint-1 WHERE chain='robinhood'`,
    [nextBlock]);
    await client.query(`DELETE FROM robinhood_holder_legacy_coverage_manifest
      WHERE chain='robinhood' AND token_address=ANY($1::varchar[])`, [TOKENS]);
    await client.query(`DELETE FROM robinhood_holder_token_states
      WHERE chain='robinhood' AND token_address=ANY($1::varchar[])`, [TOKENS]);
    await client.query(`INSERT INTO robinhood_holder_token_states (
      chain,token_address,holder_count,ledger_status,deployment_block,backfill_next_block
    ) VALUES ('robinhood',$1,0,'shadow',100,100)`, [TOKEN]);
    await client.query(`INSERT INTO robinhood_holder_token_states (
      chain,token_address,holder_count,ledger_status,deployment_block,backfill_next_block,
      live_through_block,live_through_hash
    ) VALUES ('robinhood',$1,0,'live',$2,$2,$2,$3)`, [OLD_TOKEN, oldBlock, HASH]);
    await client.query(`UPDATE robinhood_holder_legacy_coverage_builds SET
      after_token_address=$1,completed_at=NULL,scanned=0,inserted=0,rejected=0
      WHERE chain='robinhood'`, [BEFORE_TOKEN]);

    const builder = createRobinhoodHolderLegacyManifestBuilder({ database });
    const preview = await builder.batch({ limit: 10 });
    assert.equal(preview.eligible, 2);
    assert.equal((await client.query(`SELECT 1 FROM robinhood_holder_legacy_coverage_manifest
      WHERE token_address=$1`, [TOKEN])).rowCount, 0);
    const first = await builder.batch({ apply: true, limit: 10 });
    assert.equal(first.inserted, 2);
    assert.equal((await client.query(`SELECT coverage_generation FROM
      robinhood_holder_legacy_coverage_manifest WHERE token_address=$1`, [TOKEN])).rows[0]
      .coverage_generation, '0');
    assert.equal((await builder.batch({ apply: true, limit: 10 })).complete, true);
    const repeated = await builder.batch({ apply: true, restart: true, limit: 10 });
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.alreadyPresent, 2);
    await builder.batch({ apply: true, limit: 10 });

    await client.query(`UPDATE robinhood_holder_token_states SET ledger_status='drifted'
      WHERE token_address=$1`, [TOKEN]);
    await client.query(`UPDATE robinhood_holder_token_states SET ledger_status='shadow'
      WHERE token_address=$1`, [TOKEN]);
    await assert.rejects(builder.batch({ apply: true, restart: true, limit: 10 }),
      /manifest conflict/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
