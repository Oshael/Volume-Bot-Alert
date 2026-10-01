process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, describe, it } = require('node:test');
const baseDb = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const stage50 = require('../src/utils/db-init-stage50');
const stage129 = require('../src/utils/db-init-stage129');
const stage256 = require('../src/utils/db-init-stage256');
const stage258 = require('../src/utils/db-init-stage258');
const stage259 = require('../src/utils/db-init-stage259');
const { inspectScopeBaseline, prepareScopeBaseline } = require('../src/models/robinhood-wallet-transfer-scope-membership');
const { main } = require('../src/utils/bootstrap-robinhood-wallet-transfer-scope-membership');
const schema = `test_scopem_${randomUUID().replaceAll('-', '')}`;
const db = {
  async getClient() {
    const client = await baseDb.getClient();
    await client.query(`SET search_path TO ${schema}`);
    return client;
  },
  async query(sql, params) {
    const client = await this.getClient();
    try { return await client.query(sql, params); } finally { client.release(); }
  },
};
const TOKENS = ['a', 'b', 'c'].map((digit) => `0x${digit.repeat(40)}`);
const HASH = `0x${'f'.repeat(64)}`;
let initialized = false;

async function fixture(reusable = false, stream = 'live') {
  const projectionVersion = `test_scope_${randomUUID().replaceAll('-', '')}`;
  const scopeHash = createHash('sha256').update(TOKENS.join('\n')).digest('hex');
  if (reusable) {
    await db.query(`INSERT INTO robinhood_wallet_transfer_token_scopes VALUES
      ('robinhood',$1,$2,NOW()) ON CONFLICT DO NOTHING`, [scopeHash, TOKENS]);
  }
  await db.query(`INSERT INTO robinhood_wallet_transfer_cursors
    (chain,projection_version,stream,next_block,next_block_time,checkpoint_block,checkpoint_hash)
    VALUES ('robinhood',$1,$3,101,NOW(),100,$2)`, [projectionVersion, HASH, stream]);
  await db.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
    (chain,projection_version,stream,from_block,through_block,checkpoint_hash,token_addresses,token_scope_hash,filter_mode)
    VALUES ('robinhood',$1,$5,100,100,$2,$3,$4,'topics-only')`,
  [projectionVersion, HASH, reusable ? null : TOKENS, reusable ? scopeHash : null, stream]);
  return { projectionVersion, stream, batchSize: 2 };
}

async function memberCount(input) {
  const { rows } = await db.query(`SELECT count(*)::int AS count FROM robinhood_wallet_transfer_scope_members m
    JOIN robinhood_wallet_transfer_scope_heads h USING (scope_id) WHERE h.projection_version=$1`, [input.projectionVersion]);
  return rows[0].count;
}

describe('Transfer scope baseline persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(baseDb);
    await baseDb.query(`CREATE SCHEMA ${schema}`);
    initialized = true;
    for (const stage of [stage50, stage129, stage256, stage258]) {
      for (const sql of stage.STATEMENTS) await db.query(sql);
    }
    for (let attempt = 0; attempt < 2; attempt++) await stage259.init({ database: db, closePool: false });
  });
  after(async () => {
    if (initialized) await baseDb.query(`DROP SCHEMA ${schema} CASCADE`);
    await baseDb.pool.end();
  });
  it('installs the additive contract idempotently', async () => {
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage259-robinhood-transfer-scope-membership');
    for (const table of group.tables) {
      const { rows } = await db.query(`SELECT attname FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`, [table.table]);
      for (const column of table.columns) assert.ok(rows.some((row) => row.attname === column), column);
      const constraints = await db.query(`SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass`, [table.table]);
      for (const constraint of table.constraints) assert.ok(constraints.rows.some((row) => row.conname === constraint.name), constraint.name);
      for (const index of table.indexes || []) assert.ok((await db.query('SELECT to_regclass($1) AS oid', [index.name])).rows[0].oid);
    }
  });
  for (const reusable of [false, true]) it(`resumes bounded copies of ${reusable ? 'reusable' : 'inline'} scopes`, async () => {
    const input = await fixture(reusable, reusable ? 'seed' : 'live');
    const inspected = await main([`--projection-version=${input.projectionVersion}`, `--stream=${input.stream}`], db);
    assert.equal(inspected.scope_id, null);
    const partial = await prepareScopeBaseline(db, input);
    assert.equal(partial.state, 'preparing');
    assert.equal(partial.inserted, 2);
    const complete = await prepareScopeBaseline({ getClient: () => db.getClient() }, input);
    assert.equal(complete.state, 'ready');
    assert.equal(complete.inserted, 1);
    assert.equal((await prepareScopeBaseline(db, input)).inserted, 0);
    assert.equal(await memberCount(input), 3);
    assert.equal((await inspectScopeBaseline(db, input)).cursor_version, '0');
  });
  it('rolls back inserted members and their progress together', async () => {
    const input = await fixture();
    await prepareScopeBaseline(db, input);
    const faulty = { getClient: async () => {
      const client = await db.getClient();
      return { release: () => client.release(), query: (sql, params) => {
        if (sql.startsWith('UPDATE robinhood_wallet_transfer_scope_heads')) throw new Error('injected progress failure');
        return client.query(sql, params);
      } };
    } };
    await assert.rejects(prepareScopeBaseline(faulty, input), /injected progress failure/);
    assert.equal(await memberCount(input), 2);
    assert.equal((await inspectScopeBaseline(db, input)).loaded_tokens, 2);
    assert.equal((await prepareScopeBaseline(db, input)).state, 'ready');
  });
  for (const update of ["version=version+1,next_block=102", `checkpoint_hash='0x${'e'.repeat(64)}'`]) {
    it(`rejects a stale cursor fence: ${update}`, async () => {
      const input = await fixture();
      await prepareScopeBaseline(db, input);
      await db.query(`UPDATE robinhood_wallet_transfer_cursors SET ${update} WHERE projection_version=$1`, [input.projectionVersion]);
      await assert.rejects(prepareScopeBaseline(db, input), /baseline cursor fence changed/);
      assert.equal(await memberCount(input), 2);
    });
  }
  it('rejects active workers before creating a baseline', async () => {
    const input = await fixture();
    const client = await db.getClient();
    try {
      await client.query('CREATE TEMP TABLE worker_leases (lease_key text, lease_until timestamptz)');
      await client.query(`INSERT INTO worker_leases VALUES ('robinhood-wallet-transfer-live-worker',NOW()+INTERVAL '1 hour')`);
      const database = { getClient: async () => ({ query: (sql, params) => client.query(sql, params), release() {} }) };
      await assert.rejects(prepareScopeBaseline(database, input), /worker lease is active/);
      assert.equal((await inspectScopeBaseline(db, input)).scope_id, null);
    } finally {
      await client.query('DROP TABLE pg_temp.worker_leases');
      client.release();
    }
  });
  it('serializes simultaneous preparations without copying a batch twice', async () => {
    const input = await fixture();
    const results = await Promise.all([prepareScopeBaseline(db, input), prepareScopeBaseline(db, input)]);
    assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 3);
    assert.equal(await memberCount(input), 3);
  });
  it('rejects source mutation instead of marking a mixed baseline ready', async () => {
    const input = await fixture();
    await prepareScopeBaseline(db, input);
    await db.query(`UPDATE robinhood_wallet_transfer_scan_scopes SET token_addresses[3]=$2
      WHERE projection_version=$1`, [input.projectionVersion, `0x${'d'.repeat(40)}`]);
    await assert.rejects(prepareScopeBaseline(db, input), /copied baseline scope hash mismatch/);
    assert.equal((await inspectScopeBaseline(db, input)).state, 'preparing');
    assert.equal(await memberCount(input), 2);
  });
  it('rejects unsafe batch bounds and missing evidence before writes', async () => {
    for (const batchSize of [0, 5001, 1.5]) await assert.rejects(prepareScopeBaseline(db, { batchSize }), /batchSize/);
    await assert.rejects(prepareScopeBaseline(db, { projectionVersion: 'test_missing_scope' }), /cursor is missing/);
    const input = await fixture();
    await db.query('DELETE FROM robinhood_wallet_transfer_scan_scopes WHERE projection_version=$1', [input.projectionVersion]);
    await assert.rejects(prepareScopeBaseline(db, input), /committed scope at checkpoint is missing/);
  });
  it('enforces readiness, version references and scope identity in the database', async () => {
    const head = await prepareScopeBaseline(db, await fixture());
    for (const [sql, constraint] of [
      ["UPDATE robinhood_wallet_transfer_scope_heads SET state='ready' WHERE scope_id=$1", 'rh_transfer_scope_head_progress'],
      ['UPDATE robinhood_wallet_transfer_scope_members SET valid_to_version=0 WHERE scope_id=$1', 'rh_transfer_scope_member_bounds'],
      ['UPDATE robinhood_wallet_transfer_scope_heads SET current_version=999 WHERE scope_id=$1', 'rh_transfer_scope_current_version_fkey'],
      [`INSERT INTO robinhood_wallet_transfer_scan_scopes
        (chain,projection_version,stream,from_block,through_block,checkpoint_hash,filter_mode,scope_id,scope_version)
        VALUES ('robinhood','test_wrong_scope','live',101,101,'${HASH}','topics-only',$1,0)`, 'rh_transfer_scan_scope_identity_fkey'],
    ]) await assert.rejects(db.query(sql, [head.scope_id]), new RegExp(constraint));
  });
});
