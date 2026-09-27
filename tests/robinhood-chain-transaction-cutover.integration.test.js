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

it('drops only the old event FK and keeps the validated leaf FK through both renames',
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
      await client.query(`CREATE TABLE public.rh_tx_cutover_shadow_b0 PARTITION OF ${shadow}
        FOR VALUES FROM (0) TO (250000)`);
      await client.query(`CREATE TABLE ${events} (
        chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
        transaction_hash text NOT NULL,
        CONSTRAINT rh_tx_cutover_old_fk FOREIGN KEY
          (chain, block_hash, transaction_hash) REFERENCES ${active}
          ON DELETE CASCADE) PARTITION BY RANGE (block_number)`);
      await client.query(`CREATE TABLE public.rh_tx_cutover_events_b0 PARTITION OF ${events}
        FOR VALUES FROM (0) TO (250000)`);
      await client.query(`INSERT INTO ${active} VALUES ('robinhood','block','transaction')`);
      await client.query(`INSERT INTO ${shadow} VALUES ('robinhood',100,'block','transaction')`);
      await client.query(`INSERT INTO ${events} VALUES ('robinhood',100,'block','transaction')`);
      await client.query(`ALTER TABLE public.rh_tx_cutover_events_b0
        ADD CONSTRAINT rh_tx_cutover_new_fk FOREIGN KEY
        (chain, block_number, block_hash, transaction_hash)
        REFERENCES ${shadow}(chain, block_number, block_hash, transaction_hash)
        ON DELETE CASCADE NOT VALID`);
      await client.query(`ALTER TABLE public.rh_tx_cutover_events_b0
        VALIDATE CONSTRAINT rh_tx_cutover_new_fk`);
      await cutover.swapRelations(client, {
        active, shadow, events, retired, oldFk: 'rh_tx_cutover_old_fk',
      });
      const fks = await client.query(`SELECT conname, convalidated,
        confrelid=to_regclass($1) AS references_active
        FROM pg_constraint WHERE conrelid=to_regclass($2) AND contype='f'
          AND conparentid=0`, [active, 'public.rh_tx_cutover_events_b0']);
      assert.deepEqual(fks.rows, [{ conname: 'rh_tx_cutover_new_fk',
        convalidated: true, references_active: true }]);
      await client.query(`DELETE FROM ${active} WHERE block_hash='block'`);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${events}`))
        .rows[0].n, 0);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${retired}`))
        .rows[0].n, 1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
