process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage = require('../src/utils/db-init-stage267');
const { inspectRuntimeSchema } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { CHANNEL, createRobinhoodHolderAdmissionQueue } = require('../src/models/robinhood-holder-admission-queue');
after(() => db.pool.end());
const TOKEN = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;

it('durably signals catalog/proof commits and preserves late proofs, retries and abandoned leases', async () => {
  await assertUsingTestDatabase(db);
  await stage.init({ closePool: false });
  await stage.init({ closePool: false });
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => key === 'stage267-robinhood-holder-admission'), false);
  const client = await db.getClient();
  const listener = await db.pool.connect();
  const messages = [];
  let delivered;
  const onNotification = (message) => {
    if (message.channel === CHANNEL && message.payload === TOKEN) {
      messages.push(message.payload); delivered?.();
    }
  };
  listener.on('notification', onNotification);
  const queue = createRobinhoodHolderAdmissionQueue({ database: { query: client.query.bind(client) } });
  try {
    await listener.query(`LISTEN ${CHANNEL}`);
    await client.query(stage.STATEMENTS[0].replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    const fixtures = {
      token_catalog: 'chain text,address text,first_seen_at timestamptz,PRIMARY KEY(chain,address)',
      robinhood_holder_token_states: 'chain text,token_address text,PRIMARY KEY(chain,token_address)',
      admin_blocked_tokens: 'chain text,address text',
      robinhood_token_attributions: `chain text,token_address text,source text,attribution_block bigint,
        attribution_tx_hash text,creator_address text,attribution_factory_address text,
        updated_at timestamptz DEFAULT NOW()`,
    };
    for (const [table, columns] of Object.entries(fixtures)) {
      await client.query(`CREATE TEMP TABLE ${table} (${columns})`);
    }
    for (const sql of stage.STATEMENTS.filter((sql) => /^(CREATE TRIGGER|DROP TRIGGER)/.test(sql))) {
      await client.query(sql);
    }
    await client.query('BEGIN');
    await client.query("INSERT INTO token_catalog VALUES ('robinhood',$1,NOW())", [TOKEN]);
    assert.equal((await queue.claim({ owner: 'first' })).length, 1);
    await client.query('ROLLBACK');
    await listener.query('SELECT 1');
    assert.equal(messages.length, 0);
    assert.deepEqual(await queue.claim({ owner: 'first' }), []);

    await client.query('BEGIN');
    await client.query("INSERT INTO token_catalog VALUES ('robinhood',$1,'2026-09-10'),('solana',$2,NOW())", [TOKEN, OTHER]);
    await client.query("INSERT INTO token_catalog VALUES ('robinhood','invalid',NOW()),('robinhood',$1,NOW())",
      ['0x0000000000000000000000000000000000000000']);
    await listener.query('SELECT 1');
    assert.equal(messages.length, 0);
    const notification = new Promise((resolve) => { delivered = resolve; });
    await client.query('COMMIT');
    let timeout;
    try {
      await Promise.race([notification, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('committed notification missing')), 3000);
      })]);
    } finally { clearTimeout(timeout); delivered = null; }
    const first = await queue.claim({ owner: 'first' });
    assert.equal(first.length, 1);
    assert.deepEqual(await queue.claim({ owner: 'second' }), []);
    assert.deepEqual(await queue.settle({ owner: 'wrong', tasks: first, completed: [TOKEN] }),
      { completed: 0, deferred: 0 });
    // Exact proof can arrive long after first_seen_at and during an existing lease.
    await client.query(`INSERT INTO robinhood_token_attributions
      (chain,token_address,source,attribution_block) VALUES ('robinhood',$1,'rpc_trace',123)`, [TOKEN]);
    await client.query('UPDATE robinhood_token_attributions SET attribution_block=123');
    assert.equal((await client.query('SELECT version::text FROM robinhood_holder_admission_queue')).rows[0].version, '2');
    assert.deepEqual(await queue.settle({ owner: 'first', tasks: first, completed: [TOKEN] }),
      { completed: 0, deferred: 1 });
    const second = await queue.claim({ owner: 'second' });
    assert.equal(second[0].version, '2');
    await queue.settle({ owner: 'second', tasks: second });
    assert.deepEqual(await queue.claim({ owner: 'third' }), []);
    // A fresh signal bypasses readiness delay; ordinary timestamp updates do not.
    await client.query('UPDATE robinhood_token_attributions SET updated_at=NOW()');
    assert.deepEqual(await queue.claim({ owner: 'third' }), []);
    await client.query('UPDATE robinhood_token_attributions SET attribution_block=124');
    const third = await queue.claim({ owner: 'third' });
    assert.equal(third[0].version, '3');
    await client.query("UPDATE robinhood_holder_admission_queue SET lease_until=NOW()-INTERVAL '1s'");
    assert.deepEqual(await queue.settle({ owner: 'third', tasks: third, completed: [TOKEN] }),
      { completed: 0, deferred: 0 });
    const reclaimed = await queue.claim({ owner: 'recovered' });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].reclaimed, true);
    await queue.settle({ owner: 'recovered', tasks: reclaimed, completed: [TOKEN] });
    assert.deepEqual(await queue.claim({ owner: 'recovered' }), []);
    await client.query("INSERT INTO robinhood_holder_token_states VALUES ('robinhood',$1)", [TOKEN]);
    await client.query('UPDATE robinhood_token_attributions SET attribution_block=125');
    assert.deepEqual(await queue.claim({ owner: 'recovered' }), []);
    await client.query('DELETE FROM robinhood_holder_token_states');
    assert.equal((await queue.claim({ owner: 'recovered' })).length, 1);
    await client.query("INSERT INTO admin_blocked_tokens VALUES ('robinhood',$1)", [TOKEN]);
    assert.deepEqual(await queue.completedAddresses([TOKEN, OTHER], '2026-09-01'), [TOKEN]);
    const current = (await client.query('SELECT token_address,version::text,attempt_count FROM robinhood_holder_admission_queue')).rows;
    await queue.settle({ owner: 'recovered', tasks: current, completed: [TOKEN] });
    await client.query('DELETE FROM admin_blocked_tokens');
    assert.equal((await queue.claim({ owner: 'recovered' })).length, 1);
    // Reconciliation is keyset-bounded and never rewrites a leased/newer signal.
    const page = await queue.reconcile({ limit: 1 });
    assert.deepEqual(page, { cursor: TOKEN, scanned: 1, enqueued: 0 });
    assert.deepEqual(await queue.reconcile({ after: 'z', limit: 1 }),
      { cursor: null, scanned: 0, enqueued: 0 });
    await client.query(`INSERT INTO robinhood_token_attributions
      (chain,token_address,source,attribution_block) VALUES ('robinhood',$1,'rpc_direct',126)`, [OTHER]);
    const earlyProof = await queue.claim({ owner: 'out-of-order' });
    assert.deepEqual(earlyProof.map((row) => row.token_address), [OTHER]);
    assert.deepEqual(await queue.completedAddresses([OTHER], '2026-09-10'), []);
    await queue.settle({ owner: 'out-of-order', tasks: earlyProof });
    await client.query("INSERT INTO token_catalog VALUES ('robinhood',$1,'2026-09-10T00:01:00Z')", [OTHER]);
    assert.equal((await queue.claim({ owner: 'out-of-order' }))[0].version, '2');
    assert.deepEqual(await queue.completedAddresses([OTHER], '2026-09-10'), []);
  } finally {
    await client.query('ROLLBACK');
    for (const table of ['robinhood_holder_admission_queue', 'token_catalog',
      'robinhood_holder_token_states', 'admin_blocked_tokens', 'robinhood_token_attributions']) {
      await client.query(`DROP TABLE IF EXISTS pg_temp.${table}`);
    }
    listener.off('notification', onNotification);
    await listener.query(`UNLISTEN ${CHANNEL}`);
    listener.release(); client.release();
  }
});
