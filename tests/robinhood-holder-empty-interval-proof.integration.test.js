'use strict';
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { captureDigest } = require('../src/models/robinhood-chain-capture-digest');
const { createEmptyHolderFrontierReader, proveEmptyHolderInterval } = require(
  '../src/models/robinhood-holder-empty-interval-proof');
const { createRobinhoodBundleRedistributionLiveQueueRepository: createQueue } = require(
  '../src/models/robinhood-bundle-redistribution-live-queue');
const { createRobinhoodBundleRedistributionLiveSource: createSource, __private } = require(
  '../src/models/robinhood-bundle-redistribution-live-source');
const { EVIDENCE_VERSION, POLICY, RULE_VERSION } = require(
  '../src/services/robinhood-bundle-redistribution-policy');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const TOKEN = `0x${'1'.repeat(40)}`;
const OTHER = `0x${'2'.repeat(40)}`;
const A = `0x${'a'.repeat(64)}`, B = `0x${'b'.repeat(64)}`, C = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`, TIME = '2026-10-05T12:00:00.000Z';
const tables = ['robinhood_holder_token_states', 'robinhood_holder_cursors',
  'robinhood_holder_transfer_journal', 'robinhood_chain_blocks', 'robinhood_chain_transactions',
  'robinhood_chain_events', 'robinhood_chain_v3_balance_snapshots', 'robinhood_chain_capture_cursor',
  'robinhood_chain_block_anchors', 'robinhood_bundle_redistribution_queue',
  'robinhood_bundle_redistribution_activations', 'robinhood_bundle_redistribution_states',
  'robinhood_bundle_redistribution_groups', 'robinhood_bundle_redistribution_members'];
let client, database;
const input = () => ({ token_address: TOKEN, live_through_block: '100',
  live_through_hash: A, event_through_block: '101' });

async function block(number, hash, parent, transactions = [], events = []) {
  const digest = captureDigest({ number: BigInt(number), hash, parentHash: parent,
    timestamp: TIME, captureVersion: 4 }, transactions, events, []);
  await client.query(`INSERT INTO robinhood_chain_blocks(chain,block_number,block_hash,
    parent_hash,capture_digest,capture_version,block_timestamp,finality,canonical,
    head_observed_at,receipts_available_at) VALUES ('robinhood',$1,$2,$3,$4,4,$5,
    'finalized',TRUE,$5,$5) ON CONFLICT(chain,block_hash) DO UPDATE SET capture_digest=$4`,
  [number, hash, parent, digest, TIME]);
}

async function addEvent(address = TOKEN, topic = TRANSFER_TOPIC) {
  const transaction = { transaction_hash: TX, transaction_index: 0, from_address: OTHER,
    to_address: TOKEN, receipt_succeeded: true, contract_address: null, nonce: null, value_wei: null };
  const event = { transaction_hash: TX, transaction_index: 0, log_index: 0,
    address, topic0: topic, topics: [topic], data: '0x' };
  await client.query(`INSERT INTO robinhood_chain_transactions(chain,block_hash,
    transaction_hash,transaction_index,from_address,to_address,receipt_succeeded)
    VALUES ('robinhood',$1,$2,0,$3,$4,TRUE)`, [B, TX, OTHER, TOKEN]);
  await client.query(`INSERT INTO robinhood_chain_events(chain,block_hash,block_number,
    transaction_hash,transaction_index,log_index,address,topic0,topics,data)
    VALUES ('robinhood',$1,101,$2,0,0,$3,$4,$5::jsonb,'0x')`,
  [B, TX, address, topic, JSON.stringify(event.topics)]);
  await block(101, B, A, [transaction], [event]);
}

before(async () => {
  await assertUsingTestDatabase(db);
  client = await db.getClient();
  for (const table of tables) await client.query(
    `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  const query = client.query.bind(client);
  database = { query, getClient: async () => ({ query, release() {} }) };
});
beforeEach(async () => {
  await client.query(`TRUNCATE ${tables.map((table) => `pg_temp.${table}`).join(',')}`);
  await block(100, A, TX); await block(101, B, A); await block(102, C, B);
  await client.query(`INSERT INTO robinhood_chain_capture_cursor(chain,next_block,
    checkpoint_block,checkpoint_hash,node_head,finalized_head,recovery_state,generation)
    VALUES ('robinhood',103,102,$1,110,102,'running',0)`, [C]);
  await client.query(`INSERT INTO robinhood_holder_cursors(chain,stream,next_block,safe_head,
    checkpoint_block,checkpoint_hash,journal_floor_block) VALUES ('robinhood','live',103,102,102,$1,100)`, [C]);
  await client.query(`INSERT INTO robinhood_holder_token_states(chain,token_address,
    holder_count,ledger_status,live_through_block,live_through_hash)
    VALUES ('robinhood',$1,0,'live',100,$2)`, [TOKEN, A]);
  await client.query(`INSERT INTO robinhood_bundle_redistribution_activations(status,
    activation_at,activation_block,activation_checkpoint_block,activation_checkpoint_hash,
    activated_at) VALUES ('active',$1,99,100,$2,$1)`, [TIME, A]);
  await client.query(`INSERT INTO robinhood_chain_block_anchors(chain,block_number,
    block_hash,block_timestamp) VALUES ('robinhood',100,$1,$2)`, [A, TIME]);
  await client.query(`INSERT INTO robinhood_bundle_redistribution_queue(token_address,
    observation_from_block,observation_from_hash,observation_from_time,event_through_block)
    VALUES ($1,100,$2,$3,101)`, [TOKEN, A, TIME]);
});
after(async () => {
  if (client) { await client.query('ROLLBACK'); await client.query('DISCARD TEMP'); client.release(); }
  await db.pool.end();
});

it('claims and materializes an empty interval without another Transfer', async () => {
  const queue = createQueue({ database });
  const [task] = await queue.claimBatch({ owner: 'empty-proof', limit: 1 });
  assert.ok(task, 'an empty canonical interval must unblock the queued event');
  assert.equal(task.sourceThroughBlock, '101');
  assert.equal(task.sourceThroughHash, B);
  const source = createSource({ database: { ...database, async query(sql, params) {
    if (sql === __private.READINESS_SQL) return { rows: [{
      ...(await client.query('SELECT * FROM pg_temp.robinhood_holder_token_states')).rows[0],
      creator_address: OTHER, attribution_block: '99', first_buy_next_time: TIME,
      first_buy_source_through: TIME, first_buy_source_next_block: '103',
      swap_lifecycle_state: 'running', swap_next_block: '103', swap_safe_head: '102',
      transfer_lifecycle_state: 'running', transfer_next_block: '103',
      observation_anchor_time: TIME, frontier_anchor_time: TIME,
    }] };
    if (sql === __private.EVIDENCE_SQL) return { rows: [] };
    return database.query(sql, params);
  } } });
  const evidence = await source.loadToken(TOKEN, task);
  assert.equal(evidence.ready, true);
  assert.equal(evidence.holderCoverage, 'empty-canonical-interval');
  assert.equal((await queue.replaceSnapshotAndComplete({ ...task, owner: 'empty-proof',
    snapshot: { state: { tokenAddress: TOKEN, ruleVersion: RULE_VERSION,
      evidenceVersion: EVIDENCE_VERSION, status: 'ready', statusReason: 'no_groups',
      sourceKind: 'live', sourceVersion: task.requestedVersion, throughBlockNumber: '101',
      throughBlockHash: B, policyJson: POLICY }, groups: [] } })).completed, true);
  assert.deepEqual((await client.query(`SELECT live_through_block::text,version::text
    FROM robinhood_holder_token_states`)).rows[0], { live_through_block: '100', version: '0' });
  assert.equal((await client.query('SELECT status FROM robinhood_bundle_redistribution_queue'))
    .rows[0].status, 'complete');
});

for (const [name, mutate] of [
  ['missing block', () => client.query('DELETE FROM robinhood_chain_blocks WHERE block_number=101')],
  ['pruned log', async () => { await addEvent(); await client.query('DELETE FROM robinhood_chain_events'); }],
  ['broken parent', () => client.query('UPDATE robinhood_chain_blocks SET parent_hash=$1 WHERE block_number=101', [TX])],
  ['unsupported capture version', () => client.query('UPDATE robinhood_chain_blocks SET capture_version=3 WHERE block_number=101')],
  ['Transfer present, including malformed logs', () => addEvent()],
  ['recovery active', () => client.query(`UPDATE robinhood_chain_capture_cursor SET
    recovery_state='recovery_required',recovery_plan='{}',recovery_detected_at=NOW()`) ],
  ['holder capture behind', () => client.query('UPDATE robinhood_holder_cursors SET safe_head=100')],
  ['holder no longer live', () => client.query("UPDATE robinhood_holder_token_states SET ledger_status='drifted'")],
  ['pending journal', () => client.query(`INSERT INTO robinhood_holder_transfer_journal(
    chain,block_number,block_hash,transaction_hash,transaction_index,log_index,token_address,
    from_wallet,to_wallet,amount_raw) VALUES ('robinhood',101,$1,$2,0,0,$3,$4,$3,1)`, [B, TX, TOKEN, OTHER])],
]) it(`keeps ${name} blocked without consuming an attempt`, async () => {
  await mutate();
  assert.equal(await proveEmptyHolderInterval(database, input()), null);
  assert.deepEqual(await createQueue({ database }).claimBatch({ owner: 'blocked', limit: 1 }), []);
  assert.deepEqual((await client.query('SELECT status,attempt_count FROM robinhood_bundle_redistribution_queue'))
    .rows[0], { status: 'pending', attempt_count: 0 });
});

it('ignores other-token events but rejects a different frozen branch and excessive ranges', async () => {
  await addEvent(OTHER);
  assert.equal((await proveEmptyHolderInterval(database, input())).through_hash, B);
  assert.equal(await proveEmptyHolderInterval(database, { ...input(), source_through_hash: TX }), null);
  assert.equal(await proveEmptyHolderInterval(database, { ...input(), event_through_block: '1101' }), null);
});

for (const [name, sql] of [
  ['holder version', 'UPDATE robinhood_holder_token_states SET version=version+1'],
  ['queue version', 'UPDATE robinhood_bundle_redistribution_queue SET requested_version=requested_version+1'],
]) it(`rejects a proof if ${name} changes before claim`, async () => {
  const proof = { ...(await proveEmptyHolderInterval(database, input())),
    holder_version: '0', requested_version: '1' };
  await client.query(sql);
  const queue = createQueue({ database, findEmptyFrontiers: async () => [proof] });
  assert.deepEqual(await queue.claimBatch({ owner: 'stale', limit: 1 }), []);
});

it('rejects an orphaned frozen frontier at publication', async () => {
  const queue = createQueue({ database });
  const [task] = await queue.claimBatch({ owner: 'orphan', limit: 1 });
  await client.query(`UPDATE robinhood_chain_blocks SET canonical=FALSE,finality='observed'
    WHERE block_number=101`);
  assert.equal(await proveEmptyHolderInterval(database, {
    ...input(), source_through_hash: task.sourceThroughHash,
  }), null);
  await assert.rejects(queue.replaceSnapshotAndComplete({ ...task, owner: 'orphan',
    snapshot: { state: { tokenAddress: TOKEN, ruleVersion: RULE_VERSION,
      evidenceVersion: EVIDENCE_VERSION, status: 'ready', statusReason: 'no_groups',
      sourceKind: 'live', sourceVersion: task.requestedVersion, throughBlockNumber: '101',
      throughBlockHash: B, policyJson: POLICY }, groups: [] } }),
  (error) => error.code === 'canonical_projection_fence_conflict');
  assert.equal((await client.query('SELECT COUNT(*)::int count FROM robinhood_bundle_redistribution_states'))
    .rows[0].count, 0);
});

it('keeps ready tasks ahead of proofs and rotates past unavailable tokens', async () => {
  await addEvent(); // First token cannot obtain an empty-interval proof.
  for (let digit = 2; digit <= 5; digit += 1) {
    const token = `0x${String(digit).repeat(40)}`;
    await client.query(`INSERT INTO robinhood_holder_token_states(chain,token_address,
      holder_count,ledger_status,live_through_block,live_through_hash)
      VALUES ('robinhood',$1,0,'live',100,$2)`, [token, A]);
    await client.query(`INSERT INTO robinhood_bundle_redistribution_queue(token_address,
      observation_from_block,observation_from_hash,observation_from_time,event_through_block)
      VALUES ($1,100,$2,$3,101)`, [token, A, TIME]);
  }
  const find = createEmptyHolderFrontierReader(database);
  const first = await find();
  const second = await find();
  assert.deepEqual(first.map((proof) => proof.token_address), [OTHER, `0x${'3'.repeat(40)}`]);
  assert.deepEqual(second.map((proof) => proof.token_address), [`0x${'4'.repeat(40)}`, `0x${'5'.repeat(40)}`]);
  await client.query(`UPDATE robinhood_holder_token_states SET live_through_block=101,
    live_through_hash=$1 WHERE token_address=$2`, [B, OTHER]);
  const queue = createQueue({ database, findEmptyFrontiers: async () => {
    assert.fail('ready live work must proceed before an empty-interval probe');
  } });
  const [ready] = await queue.claimBatch({ owner: 'ready', limit: 1 });
  assert.equal(ready.tokenAddress, OTHER);
});
