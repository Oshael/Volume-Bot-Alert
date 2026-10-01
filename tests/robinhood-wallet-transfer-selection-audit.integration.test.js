process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodWalletTransferLiveSourceRepository } = require('../src/models/robinhood-wallet-transfer-live-source');
const { listTrackedTokens } = require('../src/models/robinhood-wallet-transfer-token-selection');
const { auditBatchSelection } = require('../src/models/robinhood-wallet-transfer-selection-audit');
const { parseArgs } = require('../src/utils/audit-robinhood-wallet-transfer-selection');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const token = (id) => `0x${id.toString(16).padStart(40, '0')}`;
const hash = `0x${'a'.repeat(64)}`;
const tables = ['robinhood_holder_token_states', 'robinhood_holder_global_backfill_runs',
  'robinhood_holder_global_backfill_tokens', 'robinhood_chain_blocks', 'robinhood_chain_events',
  'robinhood_chain_capture_cursor', 'robinhood_wallet_swaps'];
let client; let database; let readonly;
async function event(address, id, malformed = false, canonicalHash = hash) {
  const topics = malformed ? [TRANSFER_TOPIC] : [TRANSFER_TOPIC,
    `0x${'0'.repeat(24)}${token(90).slice(2)}`, `0x${'0'.repeat(24)}${token(91).slice(2)}`];
  await client.query(`INSERT INTO robinhood_chain_events VALUES
    ('robinhood',101,$1,$2,0,$3,$4,$5,$6,$7)`, [canonicalHash, `0x${id.toString(16).padStart(64, '0')}`,
    id, address, TRANSFER_TOPIC, JSON.stringify(topics), `0x${'0'.repeat(63)}1`]);
}
describe('Candidate transfer selection and read-only batch parity', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    const definitions = [
      '(chain text,token_address varchar(42),ledger_status text,PRIMARY KEY(chain,token_address))',
      '(id bigint PRIMARY KEY,chain text,barrier_block bigint,status text)',
      '(run_id bigint,chain text,token_address varchar(42),status text,PRIMARY KEY(run_id,chain,token_address))',
      '(chain text,block_number bigint,block_hash text,block_timestamp timestamptz,canonical boolean)',
      '(chain text,block_number bigint,block_hash text,transaction_hash text,transaction_index int,log_index int,address text,topic0 text,topics jsonb,data text)',
      '(chain text,checkpoint_block bigint,node_head bigint)',
      '(chain text,token_address varchar(42),transaction_hash text,action_index int,wallet_address text,block_number bigint,block_time timestamptz)',
    ];
    for (let index = 0; index < tables.length; index++) await client.query(`CREATE TEMP TABLE ${tables[index]} ${definitions[index]}`);
    const query = async (sql, params) => {
      const result = await client.query(sql, params);
      if (sql.startsWith('BEGIN')) readonly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      return result;
    };
    database = { query, getClient: async () => ({ query, release() {} }) };
  });
  beforeEach(async () => {
    for (const table of tables) await client.query(`TRUNCATE ${table}`);
    await client.query(`INSERT INTO robinhood_holder_token_states VALUES
      ('robinhood',$1,'live'),('robinhood',$2,'shadow'),('robinhood',$3,'backfilling'),('robinhood',$4,'excluded')`,
    [token(1), token(2), token(3), token(4)]);
    await client.query(`INSERT INTO robinhood_holder_global_backfill_runs VALUES
      (1,'robinhood',100,'paused'),(2,'robinhood',NULL,'scanning'),(3,'robinhood',100,'completed')`);
    await client.query(`INSERT INTO robinhood_holder_global_backfill_tokens VALUES
      (1,'robinhood',$1,'active'),(1,'robinhood',$2,'active'),(1,'robinhood',$3,'excluded'),
      (2,'robinhood',$4,'active'),(3,'robinhood',$5,'active')`, [token(1), token(5), token(6), token(7), token(8)]);
    await client.query(`INSERT INTO robinhood_chain_capture_cursor VALUES ('robinhood',102,110)`);
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',100,$2,'2099-01-01T00:00:00Z',TRUE),('robinhood',101,$1,'2099-01-01T00:00:01Z',TRUE),
      ('robinhood',102,$3,'2099-01-01T00:00:02Z',TRUE)`, [hash, `0x${'c'.repeat(64)}`, `0x${'d'.repeat(64)}`]);
  });
  after(async () => {
    if (client) {
      for (const table of tables) await client.query(`DROP TABLE IF EXISTS pg_temp.${table}`);
      client.release();
    }
    await db.pool.end();
  });
  it('preserves every selection predicate, deduplication and the original repository contract', async () => {
    const repository = createRobinhoodWalletTransferLiveSourceRepository({ database });
    assert.deepEqual(await repository.listTrackedTokenAddresses(), [1, 2, 3, 5].map(token));
    assert.deepEqual(await repository.listTrackedTokenAddressesForCandidates([token(5).toUpperCase(), token(1), token(5), token(8)]),
      [token(1), token(5)]);
    assert.deepEqual(await repository.listTrackedTokenAddressesForCandidates([]), []);
    for (const values of [undefined, ['invalid'], Array(10001).fill(token(1))]) {
      await assert.rejects(repository.listTrackedTokenAddressesForCandidates(values), /candidate/);
    }
    await assert.rejects(listTrackedTokens(database, null, 2), /limit exceeded/);
  });
  it('preserves transfers and swap-only tokens in one read-only snapshot, excluding orphan logs', async () => {
    await event(token(1), 1);
    await event(token(4), 2);
    await event(token(2), 3, false, `0x${'b'.repeat(64)}`);
    await client.query(`INSERT INTO robinhood_wallet_swaps VALUES
      ('robinhood',$1,$2,1,$3,101,'2099-01-01T00:00:01Z')`, [token(5), hash, token(90)]);
    const report = await auditBatchSelection(database, { fromBlock: 100, toBlock: 102 });
    assert.equal(readonly, 'on');
    assert.equal(report.parity, true);
    assert.deepEqual([report.fullTokens, report.candidateTokens, report.selectedTokens], [4, 3, 2]);
    assert.equal(report.transferLogs, 2);
    assert.equal(report.transfers.full.count, 1);
    assert.equal(report.selectedSwaps, 1);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM robinhood_chain_events')).rows[0].count, 3);
  });
  it('retains strict rejection of selected malformed logs, and ignores unselected malformed logs', async () => {
    await event(token(4), 1, true);
    let report = await auditBatchSelection(database, { fromBlock: 100, toBlock: 102 });
    assert.equal(report.parity, true);
    assert.equal(report.transfers.candidates.ignoredMalformedLogs, 1);
    await event(token(1), 2, true);
    report = await auditBatchSelection(database, { fromBlock: 100, toBlock: 102 });
    assert.equal(report.parity, true);
    assert.equal(report.transfers.candidates.status, 'rejected');
  });
  it('accepts a proven empty range but rejects truncated, unavailable or missing-header ranges', async () => {
    const input = { fromBlock: 100, toBlock: 102 };
    assert.equal((await auditBatchSelection(database, input)).candidateTokens, 0);
    await client.query('UPDATE robinhood_chain_blocks SET block_timestamp=NULL WHERE block_number=102');
    await assert.rejects(auditBatchSelection(database, input), /timestamps/);
    await client.query("UPDATE robinhood_chain_blocks SET block_timestamp='2099-01-01T00:00:02Z' WHERE block_number=102");
    await event(token(1), 1);
    await event(token(1), 2);
    await assert.rejects(auditBatchSelection(database, { ...input, maximumRows: 1 }), /row limit/);
    await assert.rejects(auditBatchSelection(database, { fromBlock: 99, toBlock: 102 }), /coverage/);
    await client.query('DELETE FROM robinhood_chain_blocks WHERE block_number=101');
    await assert.rejects(auditBatchSelection(database, input), /header gap/);
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  });
  it('rejects invalid bounds, oversized ranges and CLI write requests', async () => {
    for (const input of [{ fromBlock: -1, toBlock: 102 }, { fromBlock: 100, toBlock: 99 },
      { fromBlock: 100, toBlock: 1100 }, { fromBlock: 100, toBlock: 102, maximumRows: 10001 }]) {
      await assert.rejects(auditBatchSelection(database, input), /invalid/);
    }
    for (const args of [['--commit'], ['--from-block=1', '--from-block=2']]) assert.throws(() => parseArgs(args), /argument/);
  });
});
