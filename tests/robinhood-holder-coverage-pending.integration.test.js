process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const stage265 = require('../src/utils/db-init-stage265');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { inspectRuntimeSchema } = require('../src/utils/runtime-schema');
const { appendCoveragePending, coveragePruneBlocker, inspectCoveragePending } =
  require('../src/models/robinhood-holder-coverage-pending');
const { CANONICAL_RECOVERY_FENCE_LOCK_ID } = require('../src/models/robinhood-canonical-projection-fence');
const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../src/services/evm-erc20-supply-delta');
after(() => db.pool.end());

it('persists holder coverage independently, validates schema and fences recovery', async () => {
  await assertUsingTestDatabase(db);
  await stage265.init({ closePool: false });
  await stage265.init({ closePool: false });
  const { report } = await inspectRuntimeSchema();
  assert.equal(report.issues.some(({ key }) => key === 'stage265-robinhood-holder-coverage-pending'), false);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(stage265.STATEMENTS[0].replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    await client.query(`CREATE TEMP TABLE admin_blocked_tokens (chain text, address text)`);
    await client.query(`CREATE TEMP TABLE robinhood_chain_blocks
      (chain text, block_number bigint, block_hash text, canonical boolean)`);
    const token = `0x${'1'.repeat(40)}`;
    const blocked = `0x${'2'.repeat(40)}`;
    const malformed = `0x${'3'.repeat(40)}`;
    const event = { address: token, topic0: TRANSFER_TOPIC,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC, ZERO_TOPIC], data: `0x${'0'.repeat(63)}1`,
      block_number: '100', block_hash: `0x${'a'.repeat(64)}`, transaction_hash: `0x${'b'.repeat(64)}` };
    await client.query("INSERT INTO admin_blocked_tokens VALUES ('robinhood', $1)", [blocked]);
    await appendCoveragePending(client, [event, { ...event, address: blocked },
      { ...event, address: malformed, data: '0x' }], '7');
    await appendCoveragePending(client, [event], '8');
    assert.deepEqual((await client.query(`SELECT generation::text, status FROM
      robinhood_holder_coverage_pending WHERE token_address=$1`, [token])).rows,
    [{ generation: '7', status: 'pending' }]);
    await appendCoveragePending(client, [{ ...event, address: malformed, block_number: '101' }], '8');
    const audit = await inspectCoveragePending(client);
    assert.equal(audit.find(({ reason }) => reason === 'admin_blocked').items, 1);
    assert.equal(audit.find(({ status }) => status === 'pending').items, 2);
    assert.equal(await coveragePruneBlocker(client, '100'), null);
    assert.equal((await coveragePruneBlocker(client, '101')).reason, 'holder_coverage_pending');
    assert.equal((await db.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired',
      [CANONICAL_RECOVERY_FENCE_LOCK_ID])).rows[0].acquired, false);
    await client.query('SAVEPOINT invalid_status');
    await assert.rejects(client.query(`UPDATE robinhood_holder_coverage_pending
      SET status='excluded' WHERE token_address=$1`, [token]), /rh_holder_coverage_pending_status_check/);
    await client.query('ROLLBACK TO SAVEPOINT invalid_status');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
