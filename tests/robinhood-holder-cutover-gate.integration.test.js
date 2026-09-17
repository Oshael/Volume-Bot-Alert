'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  createRobinhoodHolderCutoverGate,
} = require('../src/services/robinhood-holder-cutover-gate');
const {
  buildHolderCaptureReceipts,
} = require('../src/models/robinhood-holder-ledger');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FROM = `0x${'2'.repeat(40)}`;
const TO = `0x${'3'.repeat(40)}`;
const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;

after(() => db.pool.end());

it('fails closed on incomplete cohort/parity and flips only behind a retention guard', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const query = client.query.bind(client);
  const database = { getClient: async () => ({ query, release() {} }) };
  const tables = [
    'robinhood_holder_transfer_journal', 'robinhood_chain_events',
    'robinhood_chain_blocks', 'robinhood_holder_global_backfill_tokens',
    'robinhood_holder_global_backfill_runs', 'robinhood_holder_legacy_coverage_builds',
    'robinhood_holder_legacy_coverage_manifest', 'robinhood_holder_token_states',
    'robinhood_holder_capture_receipts',
    'robinhood_chain_capture_cursor', 'robinhood_holder_capture_policy',
    'robinhood_holder_cursors',
  ];
  try {
    await query(`CREATE TEMP TABLE robinhood_holder_cursors (
      chain text, stream text, next_block bigint, checkpoint_block bigint,
      checkpoint_hash text, version bigint, journal_floor_block bigint,
      buffer_floor_block bigint, updated_at timestamptz
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_capture_policy (
      chain text, capture_mode text, coverage_generation bigint, version bigint,
      cutover_next_block bigint, cutover_checkpoint_block bigint,
      cutover_checkpoint_hash text, updated_at timestamptz
    )`);
    await query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
      chain text, checkpoint_block bigint
    )`);
    await query(`CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, canonical boolean,
      block_timestamp timestamptz
    )`);
    await query(`CREATE TEMP TABLE robinhood_chain_events (
      chain text, block_number bigint, block_hash text, transaction_hash text,
      transaction_index int, log_index int, address text, topic0 text,
      topics jsonb, data text
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_transfer_journal
      (LIKE public.robinhood_holder_transfer_journal INCLUDING ALL)`);
    await query(`CREATE TEMP TABLE robinhood_holder_capture_receipts (
      chain text, block_number bigint, block_hash text, transfer_count int,
      evidence_hash text, capture_policy_version bigint,
      PRIMARY KEY (chain, block_number)
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_token_states (
      chain text, token_address text, ledger_status text,
      coverage_generation bigint, tail_capture_from_block bigint,
      deployment_block bigint, backfill_next_block bigint,
      live_through_block bigint
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_legacy_coverage_manifest (
      chain text, token_address text, coverage_generation bigint
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_legacy_coverage_builds (
      chain text, completed_at timestamptz
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs (
      chain text, id bigint, status text
    )`);
    await query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens (
      chain text, run_id bigint, token_address text, status text
    )`);
    await query(`INSERT INTO robinhood_holder_cursors VALUES
      ('robinhood','live',101,100,$1,5,90,90,NOW())`, [HASH(100)]);
    await query(`INSERT INTO robinhood_holder_capture_policy VALUES
      ('robinhood','legacy',0,1,NULL,NULL,NULL,NOW())`);
    await query(`INSERT INTO robinhood_chain_capture_cursor VALUES ('robinhood',105)`);
    for (let block = 91; block <= 100; block += 1) {
      await query(`INSERT INTO robinhood_chain_blocks VALUES ('robinhood',$1,$2,true,NOW())`,
        [block, HASH(block)]);
    }
    await query(`INSERT INTO robinhood_chain_events VALUES
      ('robinhood',100,$1,$2,0,0,$3,$4,$5::jsonb,$6)`, [
      HASH(100), HASH(200), TOKEN, TRANSFER_TOPIC,
      JSON.stringify([TRANSFER_TOPIC, topicAddress(FROM), topicAddress(TO)]),
      `0x${'0'.repeat(63)}5`,
    ]);
    await query(`INSERT INTO robinhood_holder_transfer_journal (
      chain, block_number, block_hash, transaction_hash, transaction_index,
      log_index, token_address, from_wallet, to_wallet, amount_raw
    ) VALUES ('robinhood',100,$1,$2,0,0,$3,$4,$5,5)`,
    [HASH(100), HASH(200), TOKEN, FROM, TO]);
    const [receipt] = buildHolderCaptureReceipts([{
      blockNumber: '100', blockHash: HASH(100), transactionHash: HASH(200),
      transactionIndex: 0, logIndex: 0, tokenAddress: TOKEN,
      fromWallet: FROM, toWallet: TO, amountRaw: '5',
    }]);
    await query(`INSERT INTO robinhood_holder_capture_receipts VALUES
      ('robinhood',$1,$2,$3,$4,1)`, [
      receipt.blockNumber, receipt.blockHash, receipt.transferCount, receipt.evidenceHash,
    ]);
    await query(`INSERT INTO robinhood_holder_token_states VALUES
      ('robinhood',$1,'live',1,NULL,90,90,100)`, [TOKEN]);
    await query(`INSERT INTO robinhood_holder_legacy_coverage_builds VALUES
      ('robinhood',NOW())`);

    const gate = createRobinhoodHolderCutoverGate({ database });
    assert.equal((await gate.inspect()).blockers[0], 'manifest_incomplete');
    await assert.rejects(gate.inspect({ apply: true }), {
      code: 'holder_cutover_not_ready', reason: 'manifest_incomplete',
    });
    await query(`INSERT INTO robinhood_holder_legacy_coverage_manifest VALUES
      ('robinhood',$1,1)`, [TOKEN]);
    assert.equal((await gate.inspect()).readyForGate, true);
    await query(`UPDATE robinhood_holder_capture_receipts SET evidence_hash=$1`, [HASH(999)]);
    assert.ok((await gate.inspect()).blockers.includes('recent_parity_divergent'));
    await query(`UPDATE robinhood_holder_capture_receipts SET evidence_hash=$1`, [
      receipt.evidenceHash,
    ]);
    await query(`UPDATE robinhood_chain_blocks
      SET block_timestamp=NOW()-INTERVAL '2 hours' WHERE block_number=100`);
    assert.ok((await gate.inspect()).blockers.includes('checkpoint_not_recent'));
    await query(`UPDATE robinhood_chain_blocks
      SET block_timestamp=NOW() WHERE block_number=100`);

    const unprotected = createRobinhoodHolderCutoverGate({ database, retentionGuard: {
      async assertProtected() { throw new Error('raw retention is not fenced'); },
    } });
    await assert.rejects(unprotected.inspect({ apply: true }), /raw retention is not fenced/);
    assert.equal((await query(`SELECT capture_mode FROM robinhood_holder_capture_policy`))
      .rows[0].capture_mode, 'legacy');

    await assert.rejects(gate.inspect({ apply: true }), {
      code: 'holder_cutover_not_ready', reason: 'expected_anchor_changed_or_missing',
    });
    const result = await gate.inspect({ apply: true,
      expectedNextBlock: '101', expectedCheckpointHash: HASH(100) });
    assert.equal(result.readyForGate, true);
    assert.ok(Date.parse(result.recoveryWindowUntil) > Date.now());
    const policy = (await query(`SELECT capture_mode, coverage_generation,
      cutover_next_block, version FROM robinhood_holder_capture_policy`)).rows[0];
    assert.deepEqual(policy, { capture_mode: 'tracked', coverage_generation: '1',
      cutover_next_block: '101', version: '2' });
    assert.equal((await query(`SELECT version FROM robinhood_holder_cursors`)).rows[0].version, '6');
    assert.equal((await gate.inspect()).blockers[0], 'legacy_policy_required');
  } finally {
    for (const table of tables) await query(`DROP TABLE IF EXISTS pg_temp.${table}`);
    client.release();
  }
});
