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
const stage257 = require('../src/utils/db-init-stage257');
const { createRobinhoodWalletTransferProjectionRepository } = require('../src/models/robinhood-wallet-transfer-projection');
const stage259 = require('../src/utils/db-init-stage259');
const stage262 = require('../src/utils/db-init-stage262');
const { encodeScopeBitmap } = require('../src/models/robinhood-wallet-transfer-scope-bitmap');
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

async function fixture(reusable = false, stream = 'live', tokens = TOKENS) {
  const projectionVersion = `test_scope_${randomUUID().replaceAll('-', '')}`;
  const scopeHash = createHash('sha256').update(tokens.join('\n')).digest('hex');
  if (reusable) {
    await db.query(`INSERT INTO robinhood_wallet_transfer_token_scopes (chain,scope_hash,token_addresses,created_at) VALUES
      ('robinhood',$1,$2,NOW()) ON CONFLICT DO NOTHING`, [scopeHash, tokens]);
  }
  await db.query(`INSERT INTO robinhood_wallet_transfer_cursors
    (chain,projection_version,stream,next_block,next_block_time,checkpoint_block,checkpoint_hash)
    VALUES ('robinhood',$1,$3,101,NOW(),100,$2)`, [projectionVersion, HASH, stream]);
  await db.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
    (chain,projection_version,stream,from_block,through_block,checkpoint_hash,token_addresses,token_scope_hash,filter_mode)
    VALUES ('robinhood',$1,$5,100,100,$2,$3,$4,'topics-only')`,
  [projectionVersion, HASH, reusable ? null : tokens, reusable ? scopeHash : null, stream]);
  return { projectionVersion, stream, batchSize: 2 };
}

async function memberCount(input) {
  const { rows } = await db.query(`SELECT count(*)::int AS count FROM robinhood_wallet_transfer_scope_members m
    JOIN robinhood_wallet_transfer_scope_heads h USING (scope_id) WHERE h.projection_version=$1`, [input.projectionVersion]);
  return rows[0].count;
}

function batch(input, version, tokens = TOKENS, fromBlock = 101 + version) {
  return { projectionVersion: input.projectionVersion, stream: input.stream, expectedVersion: version,
    nextBlock: String(fromBlock + 1), nextBlockTime: '2099-01-04T00:00:00Z', safeHead: '1000000',
    checkpointBlock: String(fromBlock), checkpointHash: HASH, events: [],
    captureScope: { fromBlock: String(fromBlock), tokenAddresses: tokens, filterMode: 'canonical-journal' } };
}

describe('Transfer scope baseline persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(baseDb);
    await baseDb.query(`CREATE SCHEMA ${schema}`);
    initialized = true;
    for (const stage of [stage50, stage129, stage256, stage258, stage257]) {
      for (const sql of stage.STATEMENTS) await db.query(sql);
    }
    for (let attempt = 0; attempt < 2; attempt++) await stage259.init({ database: db, closePool: false });
    await stage262.init({ database: db, closePool: false });
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
  it('bootstraps a compact checkpoint scope without changing its cursor fence', async () => {
    const input = await fixture(true);
    const dictionary = (await db.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
      SELECT 'robinhood',token FROM unnest($1::text[]) token RETURNING token_address,ordinal`, [TOKENS])).rows;
    const encoded = encodeScopeBitmap(TOKENS, dictionary);
    await db.query(`UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=NULL,scope_bitmap=$1,
      dictionary_size=$2,bitmap_token_count=$3 WHERE scope_hash=$4`,
    [encoded.bitmap, encoded.dictionarySize, encoded.tokenCount, encoded.scopeHash]);
    assert.equal((await inspectScopeBaseline(db, input)).token_count, 3);
    assert.equal((await prepareScopeBaseline(db, input)).state, 'preparing');
    assert.equal((await prepareScopeBaseline(db, input)).state, 'ready');
    assert.equal(await memberCount(input), 3);
    assert.equal((await inspectScopeBaseline(db, input)).cursor_version, '0');
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

  for (const stream of ['seed', 'live']) it(`activates only a ready ${stream} baseline and keeps conflicts atomic`, async () => {
    const input = await fixture(false, stream);
    const repository = createRobinhoodWalletTransferProjectionRepository({ database: db });
    await prepareScopeBaseline(db, input);
    await assert.rejects(repository.commitBatch(batch(input, 0)), /baseline is not ready/);
    assert.equal((await repository.loadCursor(input.projectionVersion, stream)).version, 0);
    await prepareScopeBaseline(db, input);
    const result = await repository.commitBatch(batch(input, 0));
    assert.deepEqual(result.captureScope, { format: 'versioned', scopeId: result.captureScope.scopeId,
      version: '0', added: 0, removed: 0 });
    assert.deepEqual(await repository.commitBatch(batch(input, 0, [TOKENS[0]])),
      { committed: false, reason: 'cursor_conflict' });
    assert.equal(await memberCount(input), 3);
    const scans = await db.query(`SELECT token_addresses,token_scope_hash,scope_version FROM robinhood_wallet_transfer_scan_scopes
      WHERE projection_version=$1 ORDER BY scan_scope_id`, [input.projectionVersion]);
    assert.equal(scans.rows.length, 2);
    assert.deepEqual(scans.rows[1], { token_addresses: null, token_scope_hash: null, scope_version: '0' });
  });

  it('writes only changed members at 414065 tokens across rollback and restarts', async (t) => {
    const tokens = Array.from({ length: 414065 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
    const input = await fixture(false, 'live', tokens);
    let progress;
    do { progress = await prepareScopeBaseline(db, { ...input, batchSize: 5000 }); } while (progress.state !== 'ready');
    const writes = [];
    let failCursor = false;
    const database = { query: (sql, params) => db.query(sql, params), getClient: async () => {
      const client = await db.getClient();
      return { release: () => client.release(), query: async (sql, params) => {
        assert.ok(!sql.includes('INSERT INTO robinhood_wallet_transfer_token_scopes'), 'must not persist a complete token array');
        if (failCursor && sql.includes('UPDATE robinhood_wallet_transfer_cursors')) {
          failCursor = false;
          throw new Error('injected cursor failure');
        }
        const result = await client.query(sql, params);
        if (/^(INSERT INTO|UPDATE) robinhood_wallet_transfer_scope_members/.test(sql)) {
          writes.push({ rows: result.rowCount, payload: params[2].length });
        }
        return result;
      } };
    } };
    const repository = () => createRobinhoodWalletTransferProjectionRepository({ database });
    assert.equal((await repository().commitBatch(batch(input, 0, tokens.toReversed()))).captureScope.version, '0');
    assert.deepEqual(writes, []);
    tokens[0] = `0x${(420000).toString(16).padStart(40, '0')}`;
    failCursor = true;
    await assert.rejects(repository().commitBatch(batch(input, 1, tokens)), /injected cursor failure/);
    assert.equal((await repository().loadCursor(input.projectionVersion, 'live')).version, 1);
    const headVersion = async () => (await db.query(`SELECT current_version,token_count FROM robinhood_wallet_transfer_scope_heads
      WHERE projection_version=$1`, [input.projectionVersion])).rows[0];
    assert.deepEqual(await headVersion(), { current_version: '0', token_count: 414065 });
    assert.equal(await memberCount(input), 414065);
    const persisted = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM robinhood_wallet_transfer_scope_versions WHERE scope_id=$1) AS versions,
      (SELECT count(*)::int FROM robinhood_wallet_transfer_scan_scopes WHERE scope_id=$1) AS scans,
      (SELECT count(*)::int FROM robinhood_wallet_transfer_scope_members
        WHERE scope_id=$1 AND valid_to_version IS NULL) AS active`, [progress.scope_id])).rows[0];
    assert.deepEqual(await persisted(), { versions: 1, scans: 1, active: 414065 });
    for (let version = 1; version <= 3; version++) {
      tokens[version - 1] = `0x${(420000 + version - 1).toString(16).padStart(40, '0')}`;
      const result = await repository().commitBatch(batch(input, version, tokens));
      assert.deepEqual(result.captureScope, { format: 'versioned', scopeId: progress.scope_id,
        version: String(version), added: 1, removed: 1 });
    }
    assert.deepEqual(await headVersion(), { current_version: '3', token_count: 414065 });
    assert.equal(await memberCount(input), 414068);
    assert.deepEqual(await persisted(), { versions: 4, scans: 4, active: 414065 });
    assert.equal(writes.length, 8); // One rolled-back delta plus three committed changes.
    assert.ok(writes.every((write) => write.rows === 1 && write.payload === 1));
    t.diagnostic('414065 tokens: each churn wrote 1 added and 1 removed member; no complete array persisted');
  });

  it('replays a rewound cursor with a new membership version while preserving previous ranges', async () => {
    const input = await fixture();
    await prepareScopeBaseline(db, { ...input, batchSize: 5000 });
    const repository = createRobinhoodWalletTransferProjectionRepository({ database: db });
    assert.equal((await repository.commitBatch(batch(input, 0, TOKENS.slice(1)))).captureScope.version, '1');
    await db.query(`UPDATE robinhood_wallet_transfer_cursors SET next_block=101,checkpoint_block=100,
      checkpoint_hash=$2,version=version+1 WHERE projection_version=$1`, [input.projectionVersion, HASH]);
    const replay = batch(input, 2, TOKENS, 101);
    replay.checkpointHash = `0x${'e'.repeat(64)}`;
    const result = await repository.commitBatch(replay);
    assert.equal(result.captureScope.version, '2');
    const memberships = await db.query(`SELECT valid_from_version,valid_to_version FROM robinhood_wallet_transfer_scope_members
      WHERE scope_id=$1 AND token_address=$2 ORDER BY valid_from_version`, [result.captureScope.scopeId, TOKENS[0]]);
    assert.deepEqual(memberships.rows, [
      { valid_from_version: '0', valid_to_version: '1' }, { valid_from_version: '2', valid_to_version: null },
    ]);
    const scans = await db.query(`SELECT scope_version,checkpoint_hash FROM robinhood_wallet_transfer_scan_scopes
      WHERE projection_version=$1 AND scope_id IS NOT NULL ORDER BY scan_scope_id`, [input.projectionVersion]);
    assert.deepEqual(scans.rows, [{ scope_version: '1', checkpoint_hash: HASH },
      { scope_version: '2', checkpoint_hash: replay.checkpointHash }]);
    await db.query(`UPDATE robinhood_wallet_transfer_cursors SET next_block=100,checkpoint_block=99,
      version=version+1 WHERE projection_version=$1`, [input.projectionVersion]);
    assert.deepEqual((await repository.commitBatch(batch(input, 4, TOKENS, 100))).captureScope,
      { format: 'legacy', reason: 'before-baseline' });
  });

  it('bounds delta payloads at 5000 members for large additions and removals', async () => {
    const input = await fixture();
    await prepareScopeBaseline(db, { ...input, batchSize: 5000 });
    const payloads = [];
    const database = { getClient: async () => {
      const client = await db.getClient();
      return { release: () => client.release(), query: (sql, params) => {
        if (/^(INSERT INTO|UPDATE) robinhood_wallet_transfer_scope_members/.test(sql)) payloads.push(params[2].length);
        return client.query(sql, params);
      } };
    } };
    const repository = createRobinhoodWalletTransferProjectionRepository({ database });
    const added = Array.from({ length: 5001 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
    assert.equal((await repository.commitBatch(batch(input, 0, TOKENS.concat(added)))).captureScope.added, 5001);
    assert.equal((await repository.commitBatch(batch(input, 1))).captureScope.removed, 5001);
    assert.deepEqual(payloads, [5000, 1, 5000, 1]);
    assert.equal((await inspectScopeBaseline(db, input)).loaded_tokens, 3);
  });
});
