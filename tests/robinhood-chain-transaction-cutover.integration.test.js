'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const cutover = require('../src/utils/cutover-robinhood-chain-transactions');

after(async () => db.pool.end());

it('accepts only contiguous complete audit summaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-tx-cutover-'));
  const file = path.join(directory, 'audit.jsonl');
  const summary = (fromBlock, throughBlock) => ({ phase: 'summary', mode: 'read-only',
    verified: true, stopReason: 'complete', nextBlock: null,
    pages: 1, transactions: 3, fromBlock, throughBlock });
  try {
    fs.writeFileSync(file, `${JSON.stringify(summary(100, 109))}\n${JSON.stringify(summary(110, 119))}\n`);
    assert.deepEqual(cutover.readAuditReports(file), {
      fromBlock: 100, throughBlock: 119, reports: 2,
    });
    fs.writeFileSync(file, `${JSON.stringify(summary(100, 109))}\n${JSON.stringify(summary(111, 119))}\n`);
    assert.throws(() => cutover.readAuditReports(file), /not contiguous/);
    assert.deepEqual(cutover.parseArgs([
      '--apply', '--expected-next-block=120', `--audit-report=${file}`,
    ]), { action: 'apply', expectedNextBlock: 120, auditReport: file });
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

it('requires replacement FKs on retained and future leaves only', () => {
  const row = (start, replacement) => ({
    relname: `robinhood_chain_events_shadow_b${start}`,
    bound: `FOR VALUES FROM ('${start}') TO ('${start + 250000}')`,
    legacy_validated: true, legacy_references_old: true,
    legacy_definition: 'FOREIGN KEY (chain, block_hash, transaction_hash) ON DELETE CASCADE',
    replacement_validated: replacement,
    references_shadow: replacement,
    definition: replacement
      ? 'FOREIGN KEY (chain, block_number, block_hash, transaction_hash) ON DELETE CASCADE'
      : null,
  });
  const leaves = [row(0, null), row(250000, true), row(500000, true)];
  assert.deepEqual(cutover.eventLeafCoverage(leaves, 250000), {
    eventPartitions: 3, historicalEventPartitions: 1,
  });
  assert.throws(() => cutover.eventLeafCoverage(leaves, 0), /retained and future/);
  assert.throws(() => cutover.eventLeafCoverage([row(0, true), ...leaves.slice(1)], 250000),
    /historical event partition/);
});

it('rejects a retained audit floor that starts inside a partition or within three days',
  async () => {
    const client = { query: async () => ({ rows: [{ old_enough: false }] }) };
    await assert.rejects(cutover.assertRetentionFloor(client, 250001, '100'),
      /partition boundary/);
    await assert.rejects(cutover.assertRetentionFloor(client, 250000, '100'),
      /three-day boundary/);
    client.query = async () => ({ rows: [{ old_enough: true }] });
    await assert.doesNotReject(cutover.assertRetentionFloor(client, 250000, '100'));
    await assert.doesNotReject(cutover.assertRetentionFloor(client, 100, '100'));
  });

it('keeps historical events while retained events switch to the validated FK',
  async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    const active = 'public.rh_tx_cutover_old';
    const shadow = 'public.rh_tx_cutover_shadow';
    const events = 'public.rh_tx_cutover_events';
    const retired = 'public.rh_tx_cutover_retired';
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE ${active} (
        chain text NOT NULL, block_hash text NOT NULL, transaction_hash text NOT NULL,
        PRIMARY KEY (chain, block_hash, transaction_hash))`);
      await client.query(`CREATE TABLE ${shadow} (
        chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
        transaction_hash text NOT NULL,
        PRIMARY KEY (chain, block_number, block_hash, transaction_hash))
        PARTITION BY RANGE (block_number)`);
      await client.query(`CREATE TABLE public.rh_tx_cutover_shadow_b250000 PARTITION OF ${shadow}
        FOR VALUES FROM (250000) TO (500000)`);
      await client.query(`CREATE TABLE ${events} (
        chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
        transaction_hash text NOT NULL,
        CONSTRAINT rh_tx_cutover_old_fk FOREIGN KEY
          (chain, block_hash, transaction_hash) REFERENCES ${active}
          ON DELETE CASCADE) PARTITION BY RANGE (block_number)`);
      await client.query(`CREATE TABLE public.rh_tx_cutover_events_b0 PARTITION OF ${events}
        FOR VALUES FROM (0) TO (250000)`);
      await client.query(`CREATE TABLE public.rh_tx_cutover_events_b250000 PARTITION OF ${events}
        FOR VALUES FROM (250000) TO (500000)`);
      await client.query(`INSERT INTO ${active} VALUES
        ('robinhood','old-block','old-transaction'),
        ('robinhood','new-block','new-transaction')`);
      await client.query(`INSERT INTO ${shadow} VALUES
        ('robinhood',250100,'new-block','new-transaction')`);
      await client.query(`INSERT INTO ${events} VALUES
        ('robinhood',100,'old-block','old-transaction'),
        ('robinhood',250100,'new-block','new-transaction')`);
      await client.query(`ALTER TABLE public.rh_tx_cutover_events_b250000
        ADD CONSTRAINT rh_tx_cutover_new_fk FOREIGN KEY
        (chain, block_number, block_hash, transaction_hash)
        REFERENCES ${shadow}(chain, block_number, block_hash, transaction_hash)
        ON DELETE CASCADE NOT VALID`);
      await client.query(`ALTER TABLE public.rh_tx_cutover_events_b250000
        VALIDATE CONSTRAINT rh_tx_cutover_new_fk`);
      await cutover.swapRelations(client, {
        active, shadow, events, retired, oldFk: 'rh_tx_cutover_old_fk',
      });
      const fks = await client.query(`SELECT conname, convalidated,
        confrelid=to_regclass($1) AS references_active
        FROM pg_constraint WHERE conrelid=to_regclass($2) AND contype='f'
          AND conparentid=0`, [active, 'public.rh_tx_cutover_events_b250000']);
      assert.deepEqual(fks.rows, [{ conname: 'rh_tx_cutover_new_fk',
        convalidated: true, references_active: true }]);
      await client.query(`DELETE FROM ${active} WHERE block_hash='new-block'`);
      await client.query(`DELETE FROM ${retired} WHERE block_hash='old-block'`);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${events}`))
        .rows[0].n, 1);
      assert.equal((await client.query(`SELECT block_hash FROM ${events}`))
        .rows[0].block_hash, 'old-block');
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${retired}`))
        .rows[0].n, 1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
